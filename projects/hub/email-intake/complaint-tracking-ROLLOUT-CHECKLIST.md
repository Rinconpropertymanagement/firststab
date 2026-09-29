# Complaint Tracking — Rollout Checklist

**Purpose:** one single, plain-English sequence for this project, so nothing gets lost. Each step links back to the real document with the actual detail.

**The source documents:**
- `projects/hub/email-intake/complaint-tracking-v1-scope.md` — the product design
- `projects/hub/email-intake/complaint-tracking-technical-spec.md` — the engineering design
- `compliance/complaint-tracking-ai-risk-assessment.md` — the formal risk document for the *original* design (steps 1–7 below)
- `compliance/archive-search-significance-complaint-merge-*.md` (ai-risk-assessment, asimov-review, mason-review, data-inventory) — the formal risk documents for the *replacement* email-sorting engine this tool runs on today (see the note after step 9)

**Last confirmed against the real, live system:** 2026-09-29 — the box-checked/unchecked state below was re-verified directly (database, code, and server), not assumed from an earlier pass of this document.

---

## The Sequence

- [x] **1. Product scope written, then revised through many rounds of real design decisions** — 2026-09-08/09
- [x] **2. Product scope reviewed by Asimov and Mason** — 2026-09-09. One real conflict found (the Fair Housing/legal hold policy) and resolved; two of Mason's recommendations explicitly declined by Peter, on the record.
- [x] **3. Technical spec written**, resolving every Section 10 item from the product review — 2026-09-09
- [x] **4. Technical spec reviewed by Neo** — 2026-09-09. One real conflict found and fixed (the email-matching-before-hold-check ordering issue) — the same class of issue later confirmed safe in the actual built code (step 6 below).
- [x] **5. Technical spec re-reviewed by Asimov and Mason** — 2026-09-09/10. Approved with conditions; all resolved (two numbers confirmed by Peter, the Legal Hold manual-override gap knowingly accepted by Peter as a risk, the `proposeAINote` failure handling specified, Mason's new database-firewall requirement added).
- [x] **6. Schema, backend, UI, tests, and Judge review all built** — 2026-09-10. 156 real test assertions, zero failures. Judge found one real thing: a design change Q made without flagging it first (though the underlying safety property held up).
- [x] **7. That one design change re-checked by Asimov specifically** — 2026-09-10. Re-confirmed safe — the actual safety property holds on every real code path. The only open note is a process one (Q should have flagged the change before making it), not a safety problem.
- [x] **8. The real database schema is live** — confirmed directly (`complaints` and `complaint_tracking_config` both exist, config has one active row, 24 real complaint rows already on file). **Correction, 2026-09-29:** one real gap was found and fixed the same day — the shared `team_member_tool_roles` permission table had never actually been taught that `complaint_tracking` is a valid tool to grant, even though the original migration file said it should be (see `supabase/migrations/20260929000000_add_complaint_tracking_to_team_member_tool_roles_check.sql` for the full story, including a first attempt at that fix that had to be corrected against the real live constraint rather than a stale comment). Step 9 below was blocked on this until today.
- [x] **9. Peter and the DO were granted access** to the `complaint_tracking` tool — 2026-09-29. Peter holds `admin`, Stephen (the Director of Operations) holds `director_of_operations`, both recorded with a `granted_by`/`granted_at` audit trail, same onboarding pattern every other Hub tool uses.
- [ ] **10. A real, monitored review period for the system as it runs *today*.** **Started 2026-09-29** — see the concrete plan and first-run results directly below before assuming this is further along, or less far along, than it is.

  > **What changed under this step — read before relying on the original wording.** This step originally meant a 14-day period reviewing the dedicated email-sorting pipeline built in steps 1–7. That pipeline was later found to be broken by design (a separate, unrelated cleanup process was silently marking every incoming email as "already handled" before Complaint Tracking ever got to look at them) and was retired before any real 14-day period ran on it. It was replaced with a shared sorting engine that also powers the separate Archive Search project — that swap was a big enough change (250,000+ historical emails in scope, not a daily trickle) that it triggered its own full Asimov/Mason review, tracked in the `archive-search-significance-complaint-merge-*` documents. That review initially came back **NOT CLEARED** — the sharpest issue was that the swap had accidentally removed the safeguard keeping the AI away from attorney-privileged mail — and has since been resolved through an outside attorney's opinion and follow-up review; the most recent verdict on file is a clean **CLEARED**.

  > **The concrete plan (Asimov's kickoff review, 2026-09-29):** at least one real manual trigger per business day (`POST /api/archive-search/process-significance-pending`, the live-pipeline route — the old `complaint-tracking/router.js` trigger is permanently retired and returns 410 Gone, see above), for 14 calendar days, continuing past 14 days if needed until at least ~25 real live-pipeline conversations have been categorized and reviewed by both Peter and Stephen — whichever takes longer. On every run: read the actual complaints created, and check specifically for (1) the one non-negotiable — did anything that's actually a big deal get filed as routine and buried; (2) tone-signal false positives; (3) whether "needs a human call" is being used sensibly; (4) any duplicate-merge suggestion is a real duplicate; (5) any owner-instruction draft note goes through the existing Operational Notes approval, never auto-posted. Cost is cents-to-low-dollars per run (order of magnitude smaller than the separate 254,000-conversation historical scan) — not a budget concern at this volume.

  > **First real run, 2026-09-29:** `curl -X POST -H "x-cron-secret: $CRON_SECRET" .../api/archive-search/process-significance-pending` — 20 conversations processed, 4 complaints created, 0 errors. Real finding, not a rehearsal: this first run's entire budget went to clearing a pre-existing backlog of 20 incomplete rows left over from the earlier historical significance scan (documented, intentional behavior — an already-Call-1-billed row is worked before any brand-new conversation), so it did not yet touch fresh live mail; expect that starting the next run. A second real bug was found and fixed the same day: AI-created complaints had no `description` text at all (the manual "Report an Issue" path sets one, this path never did), which silently made every AI-created complaint unreadable on the dashboard and unsearchable — see `archive-search/lib/significance-pass.js`'s `createComplaintRow()` and its own fix comment for the detail. Today's 4 complaints, read from their linked `missive_conversation_significance.why` text directly since the dashboard couldn't show it yet: an HOA Executive Session notice (flagged legal_exposure out of caution), a PM's standing vendor bill-pay instruction, a lockbox/ShowingTime troubleshooting thread, and internal Tax ID/W-9 collection for 1099 season. None looked like a real complaint mis-filed as routine, but that judgment is Peter and Stephen's to make, not this document's.

- [ ] **11. Exit criteria confirmed**: no real big-deal complaint ever mis-categorized as routine and buried; Peter and the DO's own sign-off that the categories are actually useful; Asimov's formal sign-off.
- [ ] **12. Only after all three of #11 are true**: this can move from manually-triggered to any kind of scheduled/automatic run.
- [ ] **Standing, not a one-time step:** Owner-in-Distress (LeadSimple) escalation stays flag-only — no real write path exists, and building one is its own future project with its own review. Outbound tenant/owner communication ("closing the loop") stays fully out of scope, permanently, until it gets its own separate build and review.

---

## What This Checklist Is Not

Not a new design document. Just a durable, single place to answer "where are we" without re-deriving it from a long conversation.
