# Archive Search — Search Performance and Content-Exclusion Architecture: Outside Counsel's Opinion

**Date received:** 2026-09-24
**Context:** Response to
`compliance/archive-search-search-performance-security-barrier-attorney-question.md`,
which asked whether replacing the `security_barrier`-based enforcement of
Archive Search's content-exclusion rules with a separate, pre-filtered
searchable copy is an internal engineering/governance decision or needs
its own legal review, and if the latter, whether that approach is sound.
This is the missing prong Asimov's and Mason's 2026-09-24
NOT CLEARED / ATTORNEY REQUIRED reviews both said was needed before Neo
builds anything. Pasted into chat by Peter; saved here verbatim for the
record before governance review.

**This is the opinion as received from Peter, reproduced verbatim below
the line.** Nothing paraphrased.

---

> **Question Presented**
>
> Rincon Management's Archive Search currently relies upon a PostgreSQL
> `security_barrier` view as part of the mechanism separating searchable
> historical email from content that Rincon has chosen to exclude.
> The excluded categories currently include:
> * held or potentially privileged/legal material;
> * conversations subject to an open or confirmed Fair Housing escalation;
>   and
> * conversations specifically suppressed by an authorized reviewer.
> The `security_barrier` architecture was intended to ensure that
> user-supplied search operations are not evaluated against excluded
> records before the exclusion conditions are applied.
> That architecture has now created a significant performance limitation
> for full-archive text search.
> Rincon therefore proposes replacing or supplementing that query-time
> architecture with a separate searchable representation containing only
> records currently eligible for Archive Search.
> Excluded records would not be placed into the searchable dataset.
> The questions are:
> 1. whether Rincon may make that architectural change through ordinary
>    management, engineering and governance judgment;
> 2. whether the proposed separate searchable dataset is
>    legally/compliance sufficient; and
> 3. what standing guidance should govern similar future architectural
>    changes.
>
> **Preliminary Opinion**
>
> Yes.
> In my opinion, Rincon may redesign the technical mechanism used to
> enforce Archive Search's existing content-exclusion rules without
> obtaining a new legal opinion for every architectural iteration.
> The legal/compliance objective is not preservation of a particular
> PostgreSQL feature.
> The relevant objective is that information Rincon has determined should
> not be available through ordinary Archive Search is not improperly
> disclosed through that system.
> If Rincon can accomplish that objective through a separate searchable
> dataset containing only eligible records, I see no reason to require
> continued use of a `security_barrier` view merely because that was the
> original implementation.
> Indeed, based upon the architecture described, a separate search corpus
> containing only eligible information is a reasonable and potentially
> simpler method of enforcing the same substantive rule.
> I would approve that approach.
>
> **1. The Existing Security Mechanism Is Not Itself the Legal
> Requirement**
>
> It is important to distinguish between:
> the control objective
> and
> the technical implementation of that objective.
> The control objective is that Archive Search users should receive
> information management has determined is eligible for ordinary search.
> The current technical implementation uses a PostgreSQL security-barrier
> view.
> That particular implementation is not itself a legal requirement.
> Rincon should therefore remain free to replace it when another
> architecture accomplishes the same business and compliance objective
> more effectively.
> The law generally does not require Rincon to preserve a particular
> database query-planning feature indefinitely.
>
> **2. A Separate Eligible-Content Search Corpus Is Reasonable**
>
> The proposed architecture is straightforward:
> Raw archive -> Rincon's eligibility/exclusion rules -> Search-eligible
> dataset -> Full-text search
> Under this design, the search engine never needs to determine whether an
> excluded record may be returned because the excluded record is not part
> of the searchable corpus in the first place.
> That is a reasonable architecture.
> From a governance perspective, I would generally prefer evaluating the
> outcome:
> Can an ordinary Archive Search user retrieve content that Rincon has
> designated as excluded?
> rather than prescribing the exact database mechanism engineering must
> use to prevent that outcome.
> If the answer remains no, engineering should ordinarily have substantial
> flexibility concerning implementation.
>
> **3. I Would Not Require Preservation of `security_barrier`**
>
> I would not make the PostgreSQL `security_barrier` setting a permanent
> governance requirement.
> It was one mechanism selected to address one identified concern.
> If that mechanism materially interferes with system performance and
> engineering can satisfy the same substantive requirement through a
> different architecture, Rincon may change it.
> This includes replacing query-time filtering with:
> * a separate searchable table;
> * a materialized or derived search corpus;
> * a dedicated search index;
> * a synchronized eligible-content store;
> * precomputed eligibility;
> * event-driven synchronization;
> * batch synchronization; or
> * another technically reasonable architecture.
> Those implementation choices should generally remain with engineering.
>
> **4. The Separate Search Corpus Does Not Need to Be Perfectly
> Synchronized in an Absolute Sense**
>
> I would not impose a requirement that the searchable copy be "perfectly
> synchronized" at every millisecond.
> That standard is unnecessarily absolute and could create an artificial
> compliance requirement that the law itself does not impose.
> Distributed and derived-data systems routinely involve short processing
> delays.
> The better standard is:
> Rincon should use a reasonable mechanism designed to cause exclusion
> decisions to propagate to the searchable dataset within a reasonable
> period appropriate to the sensitivity and operational circumstances.
> That gives engineering room to design the system.
> For example, synchronization might occur:
> * immediately through an event;
> * within seconds;
> * through a short queue;
> * through periodic reconciliation; or
> * through another reliable mechanism.
> I would not convert a specific number of seconds or minutes into a legal
> requirement unless a particular legal obligation actually demands it.
>
> **5. Immediate Removal Is Not Necessarily Required for Every
> Classification Change**
>
> The same principle applies when a communication changes from searchable
> to excluded.
> Suppose a conversation has been searchable for years and an employee
> later marks it suppressed.
> A short technical delay while that change propagates to the search
> corpus does not necessarily transform an otherwise reasonable
> architecture into a legally deficient one.
> Likewise, if a Fair Housing escalation is opened and the record
> subsequently becomes excluded, I would expect the system to remove it
> reasonably promptly.
> But I would not require Rincon to guarantee mathematically instantaneous
> propagation.
> The appropriate standard is reasonable system operation.
>
> **6. Privilege Should Not Be Overstated**
>
> The presence of attorney-related material does not change my broader
> conclusion.
> As discussed in prior opinions, Archive Search itself should not be
> treated as the system making definitive attorney-client privilege
> determinations.
> Nor should every communication identified as potentially legal
> automatically be treated as legally prohibited from employee access.
> If Rincon nevertheless chooses to maintain a "held" category as an
> internal safeguard, engineering should enforce the category reasonably.
> But the existence of that voluntary control does not mean Rincon must
> implement it through the most restrictive technically available
> architecture.
>
> **7. Fair Housing Escalations Are Similar**
>
> The same distinction applies to Fair Housing.
> The legal obligation is to avoid unlawful discriminatory housing conduct
> and appropriately address matters such as reasonable accommodations and
> other Fair Housing obligations.
> It is not a general legal requirement that every historical email
> concerning a Fair Housing issue be technically invisible to every
> ordinary employee.
> Rincon has nevertheless chosen to exclude certain open or confirmed
> escalations from ordinary Archive Search.
> That is an internal control.
> Engineering should respect the substantive classification while it
> exists.
> But engineering should remain free to determine the reasonable technical
> mechanism used to implement that classification.
>
> **8. Existence Detection Should Be Treated Proportionately**
>
> The current architecture was designed in part to prevent an authorized
> search user from determining indirectly that an excluded record exists.
> That is a legitimate security consideration.
> I would not, however, elevate absolute prevention of every conceivable
> inference channel into an independent legal requirement.
> The relevant questions should be:
> * Can the employee see the excluded content?
> * Can the employee retrieve meaningful protected information from it?
> * Does the architecture expose information in a manner inconsistent with
>   Rincon's policies?
> * Is there a realistic rather than merely theoretical disclosure
>   mechanism?
> * Are the safeguards reasonable in relation to the actual risk?
> A theoretical possibility that sophisticated timing analysis might
> reveal that some unknown excluded information exists should not
> automatically require Rincon to sacrifice substantial system
> functionality.
> Reasonable security is not synonymous with elimination of every
> theoretical information channel.
>
> **9. Periodic Reconciliation Is Sensible, but I Would Not Make It a
> Legal Approval Gate**
>
> I would consider periodic verification of the derived search corpus
> good engineering practice.
> For example, engineering could periodically compare:
> records currently eligible for search
> against
> records actually present in the search corpus.
> Any discrepancy could then be corrected.
> That provides defense in depth.
> However, I would characterize this as an engineering control rather than
> a condition requiring counsel to approve the system.
> Engineering should have discretion concerning:
> * reconciliation frequency;
> * synchronization architecture;
> * retry logic;
> * failure handling;
> * monitoring;
> * alert thresholds; and
> * repair procedures.
> The legal/governance requirement should remain outcome-oriented rather
> than implementation-specific.
>
> **10. Fail-Safe Behavior May Be Proportionate to the Failure**
>
> I also would not require the entire Archive Search system to shut down
> whenever synchronization encounters a temporary problem.
> Engineering may use proportionate failure handling.
> Depending upon the circumstances, that might mean:
> * retrying the update;
> * temporarily excluding the affected record;
> * flagging the synchronization failure;
> * temporarily restricting a particular search scope;
> * reconciling the corpus;
> * or, for a significant systemic failure, temporarily disabling search.
> The response should correspond to the actual risk.
> A minor synchronization error should not automatically require a
> company-wide search outage.
>
> **11. Engineering May Choose Between Equivalent Security Architectures**
>
> This opinion should clarify an important point from the prior standing
> guidance.
> When Rincon has already established a substantive rule such as:
> "Records in category X are not available through ordinary Archive
> Search,"
> engineering does not need renewed legal approval merely to change:
> how category X is technically prevented from appearing.
> Engineering may reasonably choose among:
> * query-time filtering;
> * row-level security;
> * security-barrier views;
> * physically separate datasets;
> * derived search tables;
> * dedicated indexes;
> * pre-filtered search services;
> * application-layer enforcement;
> * combinations of controls; or
> * other technically appropriate mechanisms.
> Legal review should generally focus on the substantive rule, not dictate
> the database architecture.
>
> **12. Removing a Control Is Not Automatically a Reduction in
> Protection**
>
> This is particularly important for future iterations.
> Suppose engineering removes a security mechanism but simultaneously
> replaces it with another mechanism that reasonably achieves the same
> objective.
> That should not be characterized as:
> "removing security."
> The correct question is:
> "What protection does the resulting system provide?"
> If a `security_barrier` view is removed because excluded records have
> been physically removed from the searchable corpus, Rincon has changed
> the mechanism.
> It has not necessarily reduced the substantive protection.
> That distinction should govern future governance reviews.
>
> **13. Rincon May Balance Security, Performance and Utility**
>
> Rincon is not required to maximize one system characteristic while
> ignoring all others.
> Management may reasonably balance:
> * confidentiality;
> * security;
> * search usefulness;
> * employee productivity;
> * performance;
> * reliability;
> * operational complexity;
> * maintenance burden;
> * cost;
> * false positives;
> * false negatives; and
> * residual risk.
> The existence of a theoretically safer architecture does not
> automatically make every less restrictive architecture legally
> deficient.
> The relevant objective is a reasonable system appropriate to Rincon's
> actual operations and risks.
>
> **14. Standing Guidance for Future Architecture Changes**
>
> Going forward, I would adopt the following rule:
> Once Rincon has established the substantive eligibility, access and use
> rules for Archive Search, management and engineering may change the
> technical mechanisms used to implement those rules without obtaining
> renewed legal approval, provided the resulting architecture reasonably
> continues to enforce the substantive rules.
> This authority includes changes involving:
> * database views;
> * `security_barrier`;
> * row-level security;
> * derived tables;
> * searchable copies;
> * materialized views;
> * full-text indexes;
> * external or internal search indexes;
> * synchronization mechanisms;
> * caches;
> * queues;
> * event-driven updates;
> * batch updates;
> * eligibility calculations;
> * suppression propagation;
> * indexing architecture;
> * query architecture;
> * performance optimizations; and
> * similar implementation details.
> The existence of sensitive content somewhere in the underlying system
> does not turn every architectural decision into a legal decision.
>
> **15. When Counsel Should Be Consulted Again**
>
> I would reserve renewed legal review for changes that alter the
> substantive rule, rather than merely its implementation.
> For example:
> * deciding that a category previously prohibited from search should now
>   become searchable where that presents a genuinely new legal issue;
> * giving a materially different outside population access;
> * changing how information is used for consequential housing decisions;
> * intentionally exposing privileged information outside an appropriate
>   context;
> * using protected characteristics as substantive decision criteria;
> * materially changing the business purpose for which sensitive
>   information is processed; or
> * eliminating an existing substantive protection without replacing it
>   with a reasonably equivalent control where that protection addresses
>   an actual legal obligation.
> Those questions are meaningfully different from selecting the technical
> architecture used to implement an already-approved rule.
>
> **Specific Opinion**
>
> I approve the separate searchable-corpus architecture described.
> Rincon may build and maintain a derived search dataset containing only
> records currently eligible for ordinary Archive Search.
> I would not require preservation of the existing `security_barrier` view
> if the new architecture reasonably prevents ordinary search operations
> from being performed against excluded content.
> I would not require perfect instantaneous synchronization as a legal
> condition.
> I would expect reasonable synchronization, ordinary failure handling,
> and sensible verification appropriate to the system.
> I would not require counsel to approve:
> * the synchronization interval;
> * queue architecture;
> * indexing method;
> * reconciliation schedule;
> * database schema;
> * implementation language;
> * retry policy; or
> * other ordinary engineering details.
> Those are engineering decisions.
>
> **Clarification of Standing Authority**
>
> This opinion should also clarify the broader Archive Search standing
> guidance.
> A change to a security mechanism is not automatically a change to the
> substantive security rule.
> Accordingly:
> Engineering may replace, simplify, remove, or redesign an existing
> technical safeguard without renewed legal approval when management
> reasonably determines that the resulting architecture continues to
> provide appropriate protection for the underlying substantive
> requirement.
> That authority should extend to future iterations.
> Governance should evaluate the resulting system as a whole rather than
> treating every historical safeguard as a permanent minimum requirement
> merely because it once existed.
>
> **Bottom Line**
>
> Rincon may proceed with the separate, eligible-content search corpus.
> The proposed architecture does not expand who is authorized to see
> information or change what information is substantively eligible for
> search.
> It changes how the existing exclusion decision is enforced.
> That is principally an engineering and management decision.
> The fact that the current implementation uses PostgreSQL's
> `security_barrier` feature does not make that feature a permanent legal
> requirement.
> Rincon should require a reasonable mechanism designed to keep excluded
> content out of the searchable corpus and to propagate later exclusion
> decisions within a reasonable operational period.
> Beyond that, engineering should have substantial discretion.
> For future issues, the standing rule should be:
> Counsel determines or advises on substantive legal boundaries.
> Management determines acceptable business risk.
> Engineering determines how to implement those boundaries efficiently and
> reliably.
> A technical safeguard should not become a permanent legal requirement
> merely because it was once selected as the implementation.
> Rincon may replace it with another reasonable architecture — and may
> continue improving that architecture without returning for a new legal
> opinion each time — so long as the substantive legal boundary remains
> materially unchanged.
