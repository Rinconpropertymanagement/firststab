# Outside Counsel Opinion — Proposed Owner and Tenant Operational Notes / AI Extraction System

**Provenance note (added 2026-09-05, per Asimov's and Mason's independent governance review):** this document was originally recorded only as "verbatim text... pasted directly into chat," with no attorney name, firm, or signature — both reviewers separately flagged that this doesn't, on its own, establish the attorney-review Rule 6 requires. Peter (CEO) was asked directly and confirmed: this opinion came from Rincon's actual outside counsel, licensed to practice in California, who has represented Rincon for years — but declined to disclose the attorney's name or firm to this AI system, citing a considered privacy concern about sharing personally identifiable information with AI. As the business owner bearing responsibility for this representation, Peter's direct confirmation is accepted as satisfying the attorney-review requirement for purposes of this build. Recommended, not required: Rincon should retain the original correspondence with counsel (email, letter, or engagement record) in its own files, outside this codebase, as the durable record of this opinion's actual provenance.

**Status: real, actual outside counsel legal opinion, received 2026-09-05. This is authoritative and supersedes Rincon's internal (non-attorney) review wherever they conflict.**

---

## Executive Conclusion

Based on the Fair Housing Act, HUD regulations, California fair housing law, current California privacy law, and available CIPA authority, I do not believe Rincon needs to adopt the highly restrictive information-suppression model proposed in the internal review.

In my view, Rincon can reasonably develop a broader operational-information system provided the system is designed around several core principles: legitimate business purpose, factual rather than evaluative information, role-based access, protection of sensitive information, human review, and a meaningful firewall between operational information and housing decisions.

The Fair Housing Act does not generally prohibit a housing provider from possessing factual information about tenants. It prohibits discrimination because of protected characteristics in housing terms, conditions, privileges, and services. HUD regulations specifically prohibit discriminatory differences in services and maintenance.

California FEHA similarly applies broadly to landlords, brokers, property-management companies, and housing-related services, and prohibits discrimination, harassment, failure to accommodate, and retaliation.

Accordingly, I would not advise Rincon to design around the assumption that less information is inherently safer. I would instead recommend controlling what information is recorded, who can see it, and what decisions it may influence.

## 1. How Broadly May Rincon Maintain Factual Tenant Operational History?

**Opinion: Generally permissible, with reasonable limits.**

I find no federal or California Fair Housing authority creating a general prohibition on maintaining factual tenant operational history for legitimate property-management purposes.

The Fair Housing Act prohibits discrimination in the terms, conditions, or privileges of housing and the provision of services because of protected characteristics. HUD's implementing regulation specifically identifies failing or delaying maintenance because of a protected characteristic as prohibited conduct.

California law similarly regulates discriminatory treatment by property managers and housing providers, rather than imposing a broad prohibition on keeping ordinary management records.

Accordingly, I would consider it reasonable for Rincon to retain factual information such as: access and scheduling history; communication preferences; property access conditions; pets relevant to entry or maintenance; maintenance-related agreements; unresolved vendor issues; billing or responsibility disputes; prior incidents relevant to current property operations; safety information; active legal or operational restrictions; instructions necessary to carry out an approved accommodation; and other objectively stated information reasonably relevant to management of the property or tenancy.

I would not require a closed enumerated whitelist of every permissible fact. Instead, I would adopt this standard: **The information must be objectively stated and reasonably related to a legitimate property-management, maintenance, safety, compliance, or customer-service purpose.**

That gives Rincon considerably more flexibility than the current proposal.

**Important limitation:** Factual accuracy does not by itself make a record harmless. For example, "Tenant filed a Fair Housing complaint last month" may be completely accurate, but that fact should not become a generalized operational warning that causes staff to treat the tenant differently. Thus, the better rule is: **Factual + legitimate purpose + appropriate audience.**

**Risk assessment: LOW TO MODERATE** — A properly structured factual operational-notes system is defensible.

## 2. May Rincon Maintain Factual Records of Tenant Complaints and Disputes?

**Opinion: Yes.**

I would not recommend prohibiting complaint and dispute information altogether. Property management necessarily involves disputes. There are legitimate business reasons to know that a charge is disputed, a maintenance issue remains unresolved, a vendor's work is contested, or management approval is required before proceeding.

The legal concern is primarily retaliation or discriminatory treatment because the tenant exercised a protected right. Federal law prohibits retaliation or interference because a person exercised rights protected by the FHA. HUD regulations expressly prohibit retaliation against someone because that person made a Fair Housing complaint or reported discriminatory housing conduct. California law likewise prohibits retaliation in housing.

Therefore: **Documenting a complaint is not the same thing as retaliating because of the complaint.**

I would permit: *"Tenant disputes responsibility for invoice #1234. Manager approval required before charge is posted."*

I would discourage: *"Tenant always disputes charges."*

And prohibit: *"Tenant is a troublemaker and complains to Fair Housing."*

The first communicates what employees need to know. The latter examples characterize the individual or turn protected activity into a negative attribute.

**Protected complaints:** Fair Housing complaints, reasonable-accommodation requests, discrimination allegations, and similar protected conduct should receive heightened protection. They may legitimately need to be documented, but I would generally place the sensitive details into a restricted compliance record rather than a routine operational note. Frontline staff should receive only the operational instruction they need — e.g., "Communication regarding this matter must be routed through management" rather than "Tenant threatened Fair Housing litigation."

**Risk assessment: MODERATE** — Permissible if factually documented and separated from retaliatory decision-making.

## 3. Is "Fact Versus Characterization" a Legally Meaningful Boundary?

**Opinion: Yes, but it should not be the only boundary.**

I agree this is a useful and legally meaningful distinction. Factual: "Tenant requested afternoon entry on the previous three service calls." Evaluative: "Tenant is difficult about access." Factual: "Tenant disputes the plumbing charge." Evaluative: "Tenant refuses to take responsibility."

The factual version reduces the possibility that subjective attitudes toward the tenant become institutionalized.

However, I recommend adding a second requirement: **Would knowing this information serve a legitimate operational purpose for the person who is being shown it?** For example, "Tenant has multiple sclerosis" could be factual, but that does not mean maintenance personnel generally need the diagnosis. Instead, "Allow additional response time at the door pursuant to an approved accommodation" provides the necessary operational information without unnecessary disclosure.

My standard: **Factual + operationally relevant + appropriate access level.**

**Risk assessment: LOW TO MODERATE** — I would endorse this as the core content standard.

## 4. May Authorized Personnel Review Information Withheld by the Fair Housing Filter?

**Opinion: Yes, and I recommend it.**

I would not give the automated Fair Housing filter absolute authority to suppress information permanently. Rincon's own testing found that approximately 91% of records flagged by the existing system were false positives. Against that background, eliminating human escalation could actually weaken system reliability.

Nothing in the FHA or FEHA requires a housing provider to prevent designated compliance personnel from seeing protected-class information. Housing providers sometimes necessarily possess such information — the most obvious example is disability information supplied in connection with a reasonable-accommodation process.

I recommend:
- Ordinary employee → sees sanitized note or notice that something was withheld.
- Authorized compliance reviewer → may inspect the underlying content.
- Compliance reviewer decides → retain restricted; convert to operationally appropriate language; or classify as a false positive and release.

I would also log the review and disposition. This is a reasonable compliance control rather than an impermissible exposure of protected information.

**Risk assessment: LOW** — I would specifically approve this feature.

## 5. May AI Review Existing Email and Propose Operational Notes?

**Opinion: Probably yes, but the CIPA/privacy architecture requires the greatest caution.**

From a Fair Housing perspective, I see an important difference between AI summarizing an operational fact and AI making or recommending a housing decision. The former is considerably less concerning. The internal proposal is expressly designed for maintenance and operational context rather than tenant approval, denial, renewal, or other housing decisions. I would permit AI to propose factual notes, subject to human and automated controls.

**CIPA:** California Penal Code §631 creates greater uncertainty. Courts recognize that CIPA applies to electronic communications, and California/Ninth Circuit authority generally recognizes that a party to a communication is differently situated from an outside eavesdropper. However, courts have divided over when third-party software operating on behalf of a business is merely a tool of that business versus a separate third-party interceptor. Recent California federal decisions expressly acknowledge the split. Some decisions have treated software providers as tools of the business and applied the party exemption.

I would therefore architect this conservatively without abandoning the feature.

**Preferred architecture:**
1. Tenant sends communication to Rincon.
2. Rincon actually receives the communication.
3. Communication resides in Rincon's system.
4. Rincon subsequently causes a contracted processor to analyze Rincon's stored copy.
5. Processor operates contractually on Rincon's behalf.
6. Processor does not independently monetize, train on, profile, sell, or otherwise use the correspondence for its own purposes.

That is materially preferable to allowing an outside AI company to intercept communications simultaneously with transmission.

**California privacy regulation:** California's privacy regulator has now adopted regulations addressing risk assessments and automated decision-making technology (ADMT). Rincon should separately determine whether it qualifies as a covered CCPA business and whether the particular processing falls within those obligations.

**Risk assessment: MODERATE** — Fair Housing risk: manageable. CIPA/privacy risk: requires specific technical review before production. I would not stop development. I would make this an architecture issue requiring counsel sign-off before launch.

## 6. What Information Should Be Absolutely Prohibited?

**Opinion: Keep the prohibited category relatively narrow.**

I would prohibit ordinary operational storage of:

- **Derogatory or subjective character judgments** — "Crazy." "Bad tenant." "Problem tenant." "Lazy." "Entitled." "High maintenance." These provide little legitimate operational value and significant evidentiary downside.
- **AI-generated personality or risk assessments** — "Tenant risk: 8/10." "Likelihood of dispute: high." "Difficult personality." I would not build this.
- **Protected-class profiling without a legitimate legal purpose** — unnecessary labels based on race, religion, sexual orientation, familial status, disability, or other protected characteristics.
- **Unnecessary medical details** — store the necessary accommodation or operational instruction rather than detailed diagnoses where possible.
- **Protected activity converted into a negative attribute** — e.g., "Filed Fair Housing complaint — problem tenant." That creates obvious retaliation evidence.
- **Discriminatory owner instructions as operational instructions** — "No Section 8." "No families with children." "Owner prefers [protected class]." California specifically protects source of income, including Section 8/Housing Choice Vouchers. However, I would not necessarily destroy such an instruction. I would retain it in a restricted compliance record together with Rincon's response: "Owner instruction rejected. Rincon advised owner that request could not be implemented." That documentation can be useful protection for Rincon.

**Risk assessment: HIGH if unrestricted** — but manageable through restricted compliance storage.

## 7. What Information Should Be Restricted Instead of Prohibited?

**Opinion: Use role-based access extensively.** I strongly prefer a tiered-access model over binary "keep/delete."

**Level 1 — Operational** (available to staff with a legitimate operational need): communication preferences; access information; maintenance history; pets relevant to access; scheduling history; vendor disputes; billing dispute status; factual property incidents; maintenance instructions; sanitized accommodation instructions.

**Level 2 — Management/Compliance Restricted:** Fair Housing complaints; accommodation documentation beyond necessary operational instructions; serious legal disputes; restraining orders; police matters; credible threats; allegations of discrimination; employee/vendor misconduct allegations; discriminatory owner instructions; highly sensitive tenant disputes.

**Level 3 — Legal/Privileged:** communications with counsel; attorney-directed investigations; litigation strategy; legal assessments; settlement discussions where applicable.

The internal memo currently proposes a considerably narrower tenant-side information set. I do not see Fair Housing authority requiring Rincon to confine itself to that narrow universe.

**Risk assessment: LOW TO MODERATE** — Role-based restriction is, in my view, one of the strongest arguments in favor of permitting a broader system.

## 8. What Safeguards Would Permit the Broader System?

A broader system is reasonably defensible if Rincon adopts the following controls:

- **A. Legitimate-purpose requirement** — every operational note must have a reasonable connection to property management, maintenance, safety, compliance, owner management, an active dispute, or customer service.
- **B. Facts rather than characterizations** — describe what happened rather than characterize the person involved.
- **C. Role-based access** — information available only to employees who reasonably need it.
- **D. Sensitive-information minimization** — where an operational instruction can achieve the objective, avoid exposing unnecessary protected-class or medical details.
- **E. Human escalation** — AI classifications and withholding decisions must be reviewable by designated humans.
- **F. No automated adverse housing decisions** — the operational AI should not make decisions regarding application approval, tenant denial, rent, deposits, renewal, termination, eviction, or other housing eligibility decisions.
- **G. Housing-decision firewall** — operational information should not automatically flow into screening or adverse housing decisions. If information later becomes legitimately relevant to such a decision, it should be independently evaluated under the standards applicable to that decision. Keeping the operational system structurally separate substantially reduces risk.
- **H. Audit trail** — record who created the note, source, date, whether AI was involved, who approved it, access level, subsequent edits, compliance escalation where relevant.
- **I. Periodic auditing** — sample notes periodically for subjective language, protected-class information, retaliation concerns, improper owner instructions, inconsistent treatment, systemic AI errors.
- **J. Correction mechanism** — management should be able to correct materially inaccurate operational information.
- **K. Retention policy** — not every mundane operational detail should remain forever; use reasonable retention schedules based on continued business relevance.
- **L. AI-provider contractual protections** — processing only at Rincon's direction; confidentiality; appropriate security; defined retention/deletion; no sale; no advertising use; no independent profiling; preferably no model training using Rincon tenant correspondence.
- **M. Specific CIPA architecture review** — counsel should review the exact technical data flow before activation.

## Overall Counsel Recommendation

I would not recommend that Rincon abandon the broader system. I also would not require the system to operate under a "when uncertain, suppress the information permanently" model.

My recommended framework: **Collect and retain objectively stated information with a legitimate operational purpose; restrict sensitive information according to role; provide human compliance escalation; and strictly control whether and how operational information may influence substantive housing decisions.**

That is different from saying the system is risk-free. It is saying the risk can be reasonably managed.

### Risk assessment summary

| Item | Rating | Guidance |
|---|---|---|
| Broad factual operational notes | Green / low-moderate | Proceed with controls |
| Factual complaint and dispute history | Green-yellow / moderate | Proceed, but protect Fair Housing and other legally protected activity |
| Human review of withheld information | Green / low | Recommended |
| AI extraction of factual information | Yellow / moderate | Proceed with development; obtain privacy/CIPA review before production |
| Sensitive information with role-based restrictions | Green-yellow | Preferable to blanket deletion |
| Complaint counts, behavioral profiling, tenant scoring | **Red** | Not recommended without much stronger justification |
| AI influencing adverse housing decisions | **Red** | Keep outside this system |

## One Important Modification to Management's Proposed Standard

I would slightly modify management's proposed question — "Is this a factual piece of information that would reasonably help Rincon manage the owner, tenant, property, maintenance situation, safety issue, or active dispute?" — to instead read:

**"Is this objectively stated information that is reasonably necessary or useful for a legitimate property-management, maintenance, safety, compliance, customer-service, or dispute-management purpose, and is it appropriate for the intended employee to receive it?"**

The last clause — appropriate for the intended employee to receive it — is important. It allows the system to be broad without making every piece of information universally visible.
