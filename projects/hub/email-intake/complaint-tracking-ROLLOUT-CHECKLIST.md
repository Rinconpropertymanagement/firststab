# Complaint Tracking — Rollout Checklist

**Purpose:** one single, plain-English sequence for this project, so nothing gets lost. Each step links back to the real document with the actual detail.

**The source documents:**
- `projects/hub/email-intake/complaint-tracking-v1-scope.md` — the product design
- `projects/hub/email-intake/complaint-tracking-technical-spec.md` — the engineering design
- `compliance/complaint-tracking-ai-risk-assessment.md` — the formal risk document

---

## The Sequence

- [x] **1. Product scope written, then revised through many rounds of real design decisions** — 2026-09-08/09
- [x] **2. Product scope reviewed by Asimov and Mason** — 2026-09-09. One real conflict found (the Fair Housing/legal hold policy) and resolved; two of Mason's recommendations explicitly declined by Peter, on the record.
- [x] **3. Technical spec written**, resolving every Section 10 item from the product review — 2026-09-09
- [x] **4. Technical spec reviewed by Neo** — 2026-09-09. One real conflict found and fixed (the email-matching-before-hold-check ordering issue) — the same class of issue later confirmed safe in the actual built code (step 6 below).
- [x] **5. Technical spec re-reviewed by Asimov and Mason** — 2026-09-09/10. Approved with conditions; all resolved (two numbers confirmed by Peter, the Legal Hold manual-override gap knowingly accepted by Peter as a risk, the `proposeAINote` failure handling specified, Mason's new database-firewall requirement added).
- [x] **6. Schema, backend, UI, tests, and Judge review all built** — 2026-09-10. 156 real test assertions, zero failures. Judge found one real thing: a design change Q made without flagging it first (though the underlying safety property held up).
- [x] **7. That one design change re-checked by Asimov specifically** — 2026-09-10. Re-confirmed safe — the actual safety property holds on every real code path. The only open note is a process one (Q should have flagged the change before making it), not a safety problem.
- [ ] **8. Peter applies the real database migration** in Supabase's SQL Editor — file already sent, waiting on Peter.
- [ ] **9. Peter grants himself and the DO access** to the `complaint_tracking` tool — same onboarding step every other Hub tool has used.
- [ ] **10. The 14-day manually-triggered review period begins**, per `compliance/complaint-tracking-ai-risk-assessment.md` — every run reviewed by Peter and the DO, not a sample.
- [ ] **11. Exit criteria confirmed**: no real big-deal complaint ever mis-categorized as routine and buried; Peter and the DO's own sign-off that the categories are actually useful; Asimov's formal sign-off.
- [ ] **12. Only after all three of #11 are true**: this can move from manually-triggered to any kind of scheduled/automatic run.
- [ ] **Standing, not a one-time step:** Owner-in-Distress (LeadSimple) escalation stays flag-only — no real write path exists, and building one is its own future project with its own review. Outbound tenant/owner communication ("closing the loop") stays fully out of scope, permanently, until it gets its own separate build and review.

---

## What This Checklist Is Not

Not a new design document. Just a durable, single place to answer "where are we" without re-deriving it from a long conversation.
