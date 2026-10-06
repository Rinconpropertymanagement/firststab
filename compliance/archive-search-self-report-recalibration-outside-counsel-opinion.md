# Archive Search — Self-Report Recalibration: Outside Counsel's Opinion

**Date received:** 2026-09-12
**Context:** Response to
`compliance/archive-search-self-report-recalibration-attorney-question.md`,
the follow-up question Peter sent regarding narrowing the Fair Housing
self-report question after real-data testing showed a 90% flag rate on the
subset of conversations reaching that check.

**This is the real, verbatim opinion, exactly as received from Peter.**
Everything below the line is counsel's own words — nothing paraphrased.
Claude's analysis and next steps follow in a clearly separate section at
the bottom.

---

> Rincon Management currently excludes an archived email from ordinary
> Archive Search results whenever automated review determines that the
> email references a protected characteristic.
>
> Testing against actual company data indicates that this standard is
> substantially overinclusive. Approximately 90% of the tested
> communications are being flagged, including ordinary communications in
> which protected characteristics are mentioned without discriminatory
> conduct, such as successfully completed reasonable accommodations.
>
> Rincon proposes changing the classification question.
>
> Rather than asking whether a communication mentions a protected
> characteristic, the system would ask whether the communication appears
> to contain:
>
> 1. adverse or differential treatment connected to a protected
>    characteristic;
> 2. an accommodation or modification request that appears denied,
>    ignored, mishandled, or unresolved; or
> 3. a discriminatory preference, limitation, steering effort,
>    differential policy, derogatory statement, or similar conduct
>    connected to protected status.
>
> Mere references to protected characteristics and routine documentation
> of properly handled accommodations would ordinarily clear the automated
> review.
>
> **Preliminary Opinion**
>
> I approve the proposed change.
>
> In my opinion, the revised standard is more closely aligned with the
> conduct regulated by federal and California Fair Housing law than the
> existing "mention of a protected characteristic" standard.
>
> I would not require Rincon to flag or remove a historical communication
> merely because it identifies or discusses a person's protected
> characteristic.
>
> The relevant legal concern is generally what was done, proposed,
> communicated, denied, limited, or decided because of the protected
> characteristic, rather than the mere fact that employees possessed
> information concerning that characteristic.
>
> Accordingly, I believe Rincon may reasonably allow trained, authorized
> employees to search communications that mention protected
> characteristics when those communications do not themselves indicate
> potentially unlawful conduct.
>
> **1. The Current Standard Is Broader Than Fair Housing Law Requires**
>
> The current system effectively treats: protected information as
> equivalent to: potential Fair Housing violation.
>
> I do not believe those concepts should be treated as equivalent.
>
> Housing providers necessarily possess protected-class information in the
> ordinary course of legitimate property management.
>
> For example: "Tenant requested grab bars because of a disability.
> Installation completed." That communication concerns disability. But it
> also documents what appears to be successful Fair Housing compliance.
>
> Similarly: "Tenant uses a Section 8 voucher; Housing Authority inspection
> scheduled Tuesday." references a protected source of income under
> California law but does not indicate discrimination.
>
> And: "Tenant's primary language is Spanish; notice provided in Spanish
> and English." contains information concerning a California-protected
> characteristic but does not, standing alone, suggest discriminatory
> treatment.
>
> There is no apparent Fair Housing purpose served by automatically
> removing all such communications from a search tool used by trained
> employees.
>
> Indeed, some of those records may help employees provide consistent
> service and demonstrate prior compliance.
>
> I therefore recommend abandoning the "protected characteristic mentioned
> = flag" standard.
>
> **2. The Proposed Standard Better Tracks Actual Legal Risk**
>
> The proposed classifier focuses on three substantially more relevant
> categories.
>
> A. Adverse or differential treatment
>
> This is directly aligned with Fair Housing law. Examples include:
> refusing service; providing materially different service; imposing
> different conditions; denying access or opportunity; threatening adverse
> action; hostile or derogatory treatment; or otherwise treating someone
> differently because of protected status.
>
> B. Accommodation or modification problems
>
> This is also appropriate. A communication documenting that an
> accommodation was requested and successfully handled should ordinarily
> clear. A communication suggesting that the request was refused, ignored,
> improperly delayed, or otherwise mishandled should flag.
>
> C. Preferences, limitations, steering and discriminatory policies
>
> This category should capture communications such as: "Owner doesn't want
> families with children." "Don't show this unit to voucher holders." "I
> don't think someone from that background would fit here."
>
> These communications create substantially more meaningful Fair Housing
> concerns than a routine factual reference to someone's protected
> characteristic.
>
> For those reasons, I believe the proposed classification standard better
> tracks actual legal exposure than the existing standard.
>
> **3. I Would Approve a Two-Bucket System**
>
> The first open question concerns my previous discussion of three
> possible classifications: flag → restrict → clear.
>
> Rincon proposes using only: flag → clear.
>
> I am comfortable with that simplification.
>
> I do not believe a third category is legally necessary.
>
> The third category was a possible system-design enhancement, not a legal
> requirement.
>
> Archive Search already has several important controls: access is
> restricted to a small group; users are professionally trained; search
> activity is logged; employees have an escalation mechanism; and Archive
> Search is an information-retrieval system rather than an automated
> housing-decision system.
>
> Against that background, I would not require Rincon to build an
> intermediate-access tier merely because a communication contains
> sensitive information.
>
> The question should instead be: Does this communication present a
> meaningful Fair Housing concern requiring review? If yes, flag it. If no,
> permit the trained employee to see it.
>
> That is a reasonable and administratively much simpler approach.
>
> Recommendation: Two buckets are sufficient. I would not delay deployment
> to build a third category.
>
> **4. The AI Question Should Focus on Conduct, Not Mere Information**
>
> I generally approve the proposed question.
>
> I would make one modest change.
>
> Rather than asking whether the conversation "shows something concerning,"
> I would use slightly more objective language:
>
> Setting aside the mere presence of a protected characteristic, does this
> conversation reasonably indicate potentially discriminatory conduct,
> treatment, policy, preference, limitation, harassment, retaliation,
> steering, or an unresolved or improperly handled accommodation/
> modification request connected to a protected characteristic?
>
> Then retain the three explanatory categories.
>
> The word "potentially" is useful. The AI is not deciding whether Rincon
> violated the law. It is deciding whether a communication warrants human
> review.
>
> Likewise, "reasonably indicate" is preferable to asking whether
> discrimination is merely conceivable.
>
> I would expressly instruct the model: Do not flag a communication solely
> because it identifies, mentions, or discusses a protected characteristic.
>
> And: Do not flag an accommodation or modification merely because one was
> requested. Flag it only where the communication reasonably indicates a
> denial, material delay, failure to respond, unresolved request,
> retaliation, or other potentially improper handling.
>
> That should materially reduce unnecessary flags.
>
> **5. Indirect and Euphemistic Language**
>
> The second open question is more difficult.
>
> Consider: "I don't think this building would really work out for someone
> in his situation, given where he's from." That could communicate
> national-origin discrimination without using an obvious discriminatory
> phrase.
>
> I would accept some residual risk here.
>
> No automated classifier can reliably identify every euphemism, coded
> statement, implication, joke, reference or contextual signal humans can
> create.
>
> That does not mean Rincon must build a system that assumes the worst
> interpretation of ambiguous language.
>
> I would add one instruction: Consider the communication in context,
> including indirect or euphemistic language. Flag where the communication
> reasonably suggests that a protected characteristic influenced or may
> influence treatment, a housing decision, service, policy, preference,
> limitation, or recommendation, even if the characteristic is referenced
> indirectly.
>
> That should capture the obvious "given where he's from" situation.
>
> But I would not instruct the AI to flag whenever language could
> conceivably be interpreted as coded discrimination. That would recreate
> the current false-positive problem.
>
> The standard should remain: reasonably suggests. Not: could possibly
> mean.
>
> **6. AI Uncertainty May Continue to Default to Review**
>
> I think the existing uncertainty rule is a good compromise.
>
> If the AI determines: Clear → searchable. Potential concern → human
> review. Genuinely uncertain → human review.
>
> That permits Rincon to make the substantive standard significantly less
> restrictive without demanding artificial certainty from the model.
>
> I would not require a high-confidence threshold for clearing every
> communication. Ordinary reasonable confidence is sufficient.
>
> **7. I Would Permit Trained Staff to Encounter Occasional False
> Negatives**
>
> This deserves an explicit answer. Yes.
>
> If this system occasionally clears an email that a lawyer reviewing it
> later believes should have been flagged, that does not itself establish
> a Fair Housing violation.
>
> The classifier is an internal compliance tool. The employee remains
> subject to Rincon's Fair Housing policies and training.
>
> If an employee searches the archive and encounters something such as:
> "Owner doesn't want families with children." the fact that the automated
> system failed to flag it does not give the employee permission to
> implement the instruction.
>
> A trained employee should recognize the issue and escalate it. That is
> precisely where professional employee judgment provides an additional
> compliance layer.
>
> I therefore would not evaluate this system according to whether it has
> zero false negatives.
>
> I would evaluate whether: the classifier + trained employees +
> escalation process + management oversight collectively provide a
> reasonable compliance structure.
>
> I believe they can.
>
> **8. Successful Accommodation Records Should Generally Be Searchable**
>
> I would be particularly clear about this.
>
> A properly handled accommodation should generally not be treated as
> suspicious content merely because disability is discussed.
>
> California CRD specifically explains that housing providers have
> obligations to make reasonable accommodations and engage in an
> interactive process where appropriate.
>
> Records showing that Rincon: received the request; evaluated it;
> communicated with the tenant; approved it; implemented it; or otherwise
> handled it appropriately can actually be valuable compliance records.
>
> I see little benefit in automatically hiding those records from the
> trained employees who may need to understand what was previously agreed
> upon.
>
> Obviously, unnecessary medical details can still be handled carefully.
>
> But: "Approved accommodation — give resident 48-hour notice before
> non-emergency maintenance entry." may be exactly what a property manager
> needs to find.
>
> **9. I Would Not Require Human Review of the Estimated 60,000–70,000
> Messages**
>
> The real-world testing strongly supports changing the standard.
>
> If approximately 90% of the relevant sample is being flagged and
> extrapolation produces tens of thousands of manual reviews, the existing
> classifier is not functioning as a useful risk-based compliance filter.
>
> A system that sends almost everything to humans is barely screening at
> all.
>
> I would not recommend spending substantial employee resources manually
> reviewing tens of thousands of ordinary communications merely because
> they mention disability, family status, vouchers, language, or another
> protected characteristic.
>
> Those resources would be better directed toward: genuinely concerning
> communications; employee training; accommodation compliance; periodic
> audits; investigation of actual complaints; and management oversight.
>
> **10. Recommended Final AI Instruction**
>
> I would approve something close to the following:
>
> Setting aside the mere presence or discussion of a protected
> characteristic, does this conversation reasonably indicate a potential
> Fair Housing concern?
>
> Flag the conversation if it reasonably indicates:
> (a) adverse, hostile, derogatory, or differential treatment connected to
> a protected characteristic, including a refusal, denial, exclusion,
> threat, different service, or materially different treatment;
> (b) a disability accommodation or modification request that appears to
> have been refused, ignored, materially delayed, retaliated against, or
> left unresolved;
> (c) a preference, limitation, policy, steering effort, recommendation,
> advertisement, instruction, or housing decision that appears influenced
> by a protected characteristic; or
> (d) indirect or euphemistic language that, viewed reasonably in context,
> suggests a protected characteristic influenced or may influence
> treatment, services, a housing decision, policy, preference, limitation,
> or recommendation.
>
> Do not flag solely because a protected characteristic is identified,
> mentioned, or discussed. Do not flag a reasonable accommodation or
> modification merely because it was requested or granted. Ordinary
> factual or operational discussion involving a protected characteristic
> should clear unless the surrounding context reasonably indicates one of
> the concerns above.
>
> If the communication presents a genuine ambiguity that cannot reasonably
> be resolved from context, send it for human review.
>
> I think that is better than the current proposed language.
>
> It captures the important indirect case without returning to the
> extremely broad "anything touching Fair Housing gets flagged" approach.
>
> **Preliminary Risk Assessment**
>
> Changing from "protected characteristic mentioned" to "potential Fair
> Housing concern": LOW RISK / RECOMMENDED
> Allowing successful accommodation records to clear: LOW RISK
> Using only flag/clear rather than flag/restrict/clear: LOW TO MODERATE
> RISK / ACCEPTABLE
> Occasional indirect language escaping the classifier: ACCEPTABLE
> RESIDUAL RISK
> Using trained employee judgment as an additional control: APPROPRIATE
> Requiring zero false negatives: NOT RECOMMENDED
> Manually reviewing an estimated 60,000–70,000 records under the existing
> standard: NOT NECESSARY IN MY VIEW
>
> **Conclusion**
>
> I approve the narrower question.
>
> It is actually closer to the substance of Fair Housing law than the
> current classifier.
>
> Federal law prohibits discriminatory housing treatment, terms, services
> and discriminatory statements/preferences because of protected
> characteristics. It also specifically protects reasonable disability
> accommodations. It does not establish a general rule that internal
> records mentioning protected characteristics must be quarantined from
> trained property-management personnel.
>
> California imposes broader protected-class requirements and applies them
> directly to property management companies, but CRD similarly focuses on
> discriminatory conduct, harassment, retaliation and accommodation
> obligations.
>
> Accordingly, I would permit Rincon to distinguish between: Information
> about a protected characteristic and Information suggesting potentially
> unlawful treatment because of a protected characteristic.
>
> Archive Search should primarily flag the second.
>
> I would accept the two-bucket architecture, add the indirect/euphemistic-
> language instruction above, retain the uncertainty-to-human-review
> mechanism, and proceed with testing against real archive data.
>
> I would not require Rincon to preserve the current 90%-flagging standard,
> add a third access tier, or design the classifier around eliminating
> every conceivable false negative.
>
> The appropriate objective is reasonable identification of meaningful
> Fair Housing risk combined with professionally trained employee
> judgment—not automated perfection.

---

## Claude's Analysis (not part of counsel's opinion)

Counsel has directly and explicitly answered both open questions from the
follow-up question, and gone further by providing his own specific
recommended final prompt (Section 10 above), which differs in wording from
the draft in the spec. Key resolutions:

- **Two-bucket design: approved outright**, with his own stated reasoning
  (existing access/logging/escalation controls are sufficient; a third
  tier was "a possible system-design enhancement, not a legal
  requirement"). This directly resolves the open question Mason and Asimov
  both flagged.
- **Indirect/euphemistic language: accepted as residual risk**, with a
  specific instruction to add (folded into his Section 10 clause (d)),
  resolving Mason's item 4 concern about the "given where he's from"
  example without requiring it be perfectly caught — counsel explicitly
  frames the standard as "reasonably suggests," not "could possibly mean."
- **Attorney review of the Rule 6 prong: satisfied.** Counsel has now
  reviewed the actual concrete prompt language and specific example pairs,
  not just the general concept — closing the gap Asimov's review
  identified.
- Counsel's own recommended instruction (Section 10) should supersede the
  version currently in the spec (which only had Mason's three fixes folded
  in, not counsel's own language) — his version is more precise
  ("reasonably indicate," "potentially," explicit non-flagging
  instructions) and is the version actually being approved here. **The
  spec must be updated to make counsel's Section 10 language the
  authoritative prompt before Q builds anything**, and this should go back
  to Mason and Asimov as a short confirmation — not a fresh full review —
  that counsel's own language is what's being built.
- Counsel explicitly does not require a shadow/trial period beyond
  "proceed with testing against real archive data" — consistent with
  Peter's own "no trial period" decision, though Mason and Asimov should
  still confirm this reading.

**Next step:** update the spec to adopt counsel's Section 10 prompt
verbatim as the build target, then a short confirmation pass with Mason and
Asimov before Q builds.
