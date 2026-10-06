# Archive Search — Layer 1 Removal: Outside Counsel's Opinion (Standing Guidance)

**Date received:** 2026-09-12
**Context:** Response to
`compliance/archive-search-layer1-removal-attorney-question.md`. Counsel
was, unprompted, perturbed at receiving another narrow question on
substantially the same underlying issue as prior Archive Search opinions,
and used this opinion to establish **standing guidance** so Rincon does not
need a new legal opinion for every future technical iteration raising the
same principle. This is real and load-bearing — see
`compliance/fair-housing-standing-counsel-guidance.md` for the extracted,
durable reference version of this guidance, to be checked BEFORE drafting
any future attorney question on a similar issue.

**This is the real, verbatim opinion, exactly as received from Peter.**
Nothing paraphrased below the line.

---

> Purpose of This Opinion
>
> Rincon Management has requested guidance concerning another technical
> change to Archive Search's Fair Housing screening process.
>
> This issue is substantially similar to the issues addressed in my prior
> opinions concerning Archive Search. Rather than requiring Rincon to seek
> a new legal opinion each time its technology team modifies a screening
> mechanism while applying the same underlying compliance principle, this
> opinion is intended to provide a broader framework that Rincon may
> reasonably apply to Archive Search and future iterations of its Fair
> Housing screening systems.
>
> Subject to the limitations described below, the principles expressed in
> my prior opinions should be considered applicable across Archive Search
> and future technical iterations that raise the same underlying issue.
>
> The consistent principle is:
>
> Fair Housing law does not require Rincon to prevent trained employees
> from encountering every reference to a protected characteristic. The
> relevant compliance concern is potentially discriminatory conduct,
> treatment, policy, preference, decision, harassment, retaliation, or
> failure to satisfy applicable accommodation obligations because of
> protected status.
>
> Rincon may therefore design its internal compliance tools to identify
> meaningful Fair Housing concerns rather than mere protected-class
> information, while relying on trained employees, reasonable escalation
> procedures, and management oversight as additional safeguards.
>
> **Current Question — Removal of Keyword-Only Screening**
>
> Archive Search presently uses two independent Fair Housing checks.
>
> The first is the contextual AI review previously considered and
> approved. It attempts to determine whether a communication reasonably
> indicates potentially discriminatory conduct rather than merely
> mentioning a protected characteristic.
>
> The second is an older keyword-based system that automatically flags
> communications containing designated protected-characteristic-related
> words regardless of context.
>
> Either system currently causes the communication to be flagged.
>
> Rincon's testing indicates that the keyword system continues to generate
> substantial false-positive volume because it applies essentially the
> same "mere mention" standard that prior opinions concluded was broader
> than Fair Housing law requires.
>
> Rincon proposes eliminating the keyword-only layer from Archive Search,
> while leaving that system unchanged wherever else it is currently used.
>
> Archive Search would therefore rely upon the contextual AI classifier
> previously reviewed.
>
> I approve this change.
>
> I do not believe Rincon is legally required to maintain a context-blind
> keyword backstop merely because such a backstop may occasionally catch
> something the contextual classifier misses.
>
> The keyword scanner is a voluntary internal compliance mechanism.
>
> Its existence does not convert it into a legally required control.
>
> Nor do I believe Rincon becomes legally obligated to preserve a redundant
> compliance mechanism merely because the company previously implemented
> it.
>
> **The Absence of an Independent Keyword Backstop**
>
> The principal tradeoff has been accurately identified.
>
> If the keyword layer is removed, a communication that the contextual AI
> incorrectly clears will not subsequently be caught merely because it
> contains a protected-characteristic keyword.
>
> That creates some incremental false-negative risk.
>
> I consider that residual risk acceptable.
>
> The appropriate legal standard is not whether Rincon has constructed
> every technically available safeguard against every conceivable
> classification error.
>
> The better question is whether Archive Search, viewed as a whole,
> represents a reasonable internal compliance system.
>
> Here it does.
>
> Archive Search: uses a contextual Fair Housing classifier; flags
> potential adverse or differential treatment; flags potentially
> mishandled accommodation requests; flags discriminatory preferences,
> limitations, policies and steering; considers indirect or euphemistic
> discriminatory language; routes uncertain classifications to review;
> fails closed when the AI system experiences a technical failure; limits
> access to a small number of trained employees; maintains logging;
> provides an escalation path; and relies on trained employees who remain
> independently responsible for complying with Rincon's Fair Housing
> policies.
>
> Against that overall architecture, I would not require a second
> context-blind keyword classifier simply to create redundancy.
>
> **Keyword Matching Is Not a Legal Safe Harbor**
>
> I would specifically caution against assuming that two classifiers are
> necessarily legally superior to one.
>
> A mechanical keyword system may increase sensitivity, but it can also
> substantially reduce precision.
>
> If the keyword system automatically flags ordinary communications such
> as: "Tenant requested a disability accommodation and it was approved."
> or: "Section 8 inspection scheduled for Tuesday." or: "Tenant has
> children and requested the additional parking space included with the
> unit." the system is not necessarily identifying additional Fair Housing
> misconduct.
>
> It may simply be identifying additional Fair Housing information.
>
> Prior opinions have consistently distinguished those concepts.
>
> Accordingly, I would not measure the adequacy of Archive Search by the
> number of independent screening layers.
>
> I would measure it by whether the system reasonably identifies the
> conduct Rincon actually needs to recognize and appropriately handle.
>
> **Reliance on AI Judgment**
>
> I am also comfortable with the fact that removing the keyword layer
> places greater reliance upon contextual AI judgment.
>
> The AI does not need to be infallible.
>
> Neither an AI classifier, keyword dictionary, trained property manager,
> compliance officer nor attorney will identify every potentially
> problematic historical statement with perfect accuracy.
>
> The appropriate objective is reasonable performance.
>
> I would therefore permit the contextual classifier to clear a
> communication when it reasonably determines that no Fair Housing concern
> exists.
>
> I would not require: a second independent automated classifier; keyword
> confirmation of every AI clearance; human review of every cleared
> communication; zero false negatives; or preservation of an obsolete
> screening layer solely because removing it theoretically reduces
> redundancy.
>
> Periodic auditing and employee escalation are sufficient additional
> controls in my opinion.
>
> **Standing Guidance for Future Iterations**
>
> Rincon should not need a new legal opinion every time engineering makes
> a technical change that raises this same underlying question.
>
> Accordingly, my prior opinions and this opinion may reasonably be treated
> as standing guidance for future iterations of Archive Search and similar
> internal information-retrieval and compliance tools, provided the
> following principles remain true:
>
> 1. Mere knowledge is distinguished from discriminatory conduct. A
>    communication should not require restriction solely because it
>    mentions a protected characteristic.
> 2. Screening focuses on meaningful Fair Housing concerns. This includes
>    potentially discriminatory treatment, preferences, policies, steering,
>    harassment, retaliation, unresolved or improperly handled
>    accommodations, and similar conduct.
> 3. Professional judgment remains part of the compliance system. Rincon
>    may reasonably rely upon trained employees to recognize and
>    appropriately handle information they encounter.
> 4. Reasonable false-negative risk is acceptable. The system need not
>    identify every conceivable direct, indirect, coded, euphemistic or
>    context-dependent Fair Housing issue.
> 5. Reasonable false-positive reduction is legitimate. Rincon may remove,
>    narrow, replace, consolidate, or redesign screening mechanisms that
>    produce excessive false positives when management reasonably
>    concludes that the revised system continues to provide appropriate
>    compliance protection.
> 6. Redundant automated controls are not inherently required. Rincon does
>    not need to maintain multiple independent classifiers merely because
>    each classifier might occasionally identify something another
>    misses.
> 7. Human escalation remains available. Employees encountering
>    potentially discriminatory material may escalate it notwithstanding
>    the automated system's classification.
> 8. Material changes in purpose require separate analysis. This standing
>    guidance applies to information retrieval, classification, flagging,
>    access and compliance-review functions. It should not automatically
>    be extended to a materially different system that uses protected
>    information to make, score, rank, recommend or automate substantive
>    housing decisions such as applicant approval, denial, rent, deposit
>    requirements, lease renewal, termination, eviction, or eligibility.
>    That would present a different legal question.
>
> **Management Authority Under This Framework**
>
> Within those boundaries, I believe Rincon management should have
> substantial discretion to approve ordinary technical changes without
> obtaining a separate legal opinion for each iteration.
>
> For example, management may reasonably authorize: removing a poorly
> performing keyword rule; adding or removing screening terms; changing AI
> prompts; consolidating multiple classifiers; modifying confidence
> thresholds; changing routing rules; reducing unnecessary flags; allowing
> additional categories of legitimate operational information to clear;
> adjusting audit sampling; changing escalation workflows; and replacing an
> older screening mechanism with a better-performing contextual system.
>
> Those are principally compliance-program design and business-judgment
> decisions, provided the resulting system remains consistent with the
> legal framework described above.
>
> **When I Would Want Rincon to Return to Counsel**
>
> I would recommend obtaining new legal review when a proposed change
> materially changes the underlying legal issue rather than merely
> changing implementation.
>
> Examples would include using protected-class information to influence a
> substantive housing decision; introducing automated tenant risk scores;
> materially expanding who can access sensitive information; eliminating
> Fair Housing training or escalation mechanisms; intentionally retaining
> discriminatory preferences for operational use; materially changing the
> purpose for which protected information is processed; or introducing a
> new privacy or statutory issue not addressed by these opinions.
>
> Those situations are different from improving the precision of an
> existing internal search and compliance system.
>
> **Specific Opinion on the Current Change**
>
> I approve removing the keyword-only Fair Housing screening layer from
> Archive Search and relying upon the contextual AI review previously
> approved.
>
> The fact that this eliminates an independent automated backstop does not
> change my opinion.
>
> There will be some residual possibility that the contextual classifier
> incorrectly clears a communication that the keyword scanner would have
> flagged.
>
> That risk is acceptable within the overall system described to me.
>
> The law does not require Rincon to maximize the number of communications
> flagged, maintain every available compliance layer, or eliminate every
> possible false negative.
>
> The appropriate objective is a reasonable system directed toward
> meaningful Fair Housing risk.
>
> The proposed change satisfies that standard.
>
> **Standing Conclusion**
>
> My prior opinions concerning Archive Search should not be read as
> isolated approvals of individual prompts or pieces of code.
>
> They reflect a broader and consistent legal view:
>
> Rincon may build useful internal information systems that permit
> professionally trained employees to exercise judgment. Fair Housing
> compliance does not require the company to suppress information merely
> because it concerns a protected characteristic, nor does it require
> automated systems designed to eliminate every conceivable false
> negative.
>
> Rincon may therefore continue refining Archive Search and related
> internal screening systems consistent with this framework without
> obtaining a new legal opinion for every technical iteration.
>
> The governing objective should remain:
>
> Reasonable identification and management of meaningful Fair Housing
> risk, combined with trained professional judgment — not maximum
> suppression, maximum flagging, or automated perfection.
>
> Subject to the boundaries identified above, I would consider future
> technical changes applying these same principles to fall within this
> standing guidance.

---

## Claude's Analysis (not part of counsel's opinion)

This directly and completely resolves the attorney-review prong Asimov and
Mason both flagged as missing (each had stated the alternative to a fresh
Mason-only extension was exactly this: a real, narrow question disclosing
both layers — now answered, explicitly and unambiguously, by counsel
himself). No further Asimov/Mason round is needed to confirm this specific
point; their own stated condition was disjunctive (Mason extension OR a
fresh attorney answer) and the fresh attorney answer is now in hand,
stronger and more direct than a Mason extension would have been.

Two of Asimov's/Mason's secondary points remain worth carrying into the
build rather than re-litigating with another review round:
- Asimov's proposed validation-sample gate before full-archive rollout
  (pull a sample of conversations Layer 1 alone would have flagged that
  Layer 2 alone clears; confirm none are real concerns) — reasonable and
  cheap to do as part of TARS's normal real-data test pass, not a reason
  to slow down the build itself.
- Mason's finding that the employee escalation mechanism's UI has no real
  caller yet (no search UI exists at all) — not a blocker for this
  specific change, since it's a pre-existing, already-known gap unrelated
  to Layer 1, but worth remembering when the search UI eventually ships.

**Status: legal question resolved by the opinion above. Governance
confirmation (Asimov, Mason) still pending as of this writing — see their
confirmation-pass files, once written, before Q builds.**
