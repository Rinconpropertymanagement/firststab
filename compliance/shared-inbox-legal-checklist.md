# Shared Inbox Email Feature — Legal Confirmation Checklist

Purpose: before the maintenance-context email feature is connected to a real
shared team inbox, each item below needs a plain yes/no. No legal reasoning
or privileged detail needs to be shared back — just which items are cleared.
These six items come from Mason's (Rincon's internal legal-review AI) review
of the proposal; nothing here is new or confidential in itself.

- [ ] **1. Privilege / legal-hold boundary.** Confirmed: emails from
      government/legal domains, containing legal-matter keywords (citation,
      code compliance, violation notice, case no., attorney, counsel,
      litigation, lawsuit, subpoena, demand letter, small claims, fair
      housing complaint, HUD/CRD complaint), or manually tagged by staff as
      "Legal Hold," are excluded from automated processing — and if *any*
      message in a thread trips this, the *whole thread* is held for a
      person, not just the flagged message. Is this the right boundary, or
      does it need to change?

- [ ] **2. Fair Housing (FEHA) sufficiency.** Confirmed: content touching
      health, disability, or other protected-class-adjacent topics is
      detected, tagged, and walled off from any decision-adjacent view
      (never used to screen, penalize, or influence a housing decision), with
      the exclusion itself logged. Is this containment sufficient for
      California's Fair Housing standard, given the broader protected-class
      list under FEHA versus federal law?

- [ ] **3. CCPA notice-at-collection.** Confirmed: what notice (if any) needs
      to go to residents/owners before their correspondence is processed
      this way, and that notice is ready or already issued.

- [ ] **4. California wiretap/eavesdropping statute (Penal Code §§ 631/632,
      "CIPA").** Confirmed: this specific use doesn't trigger that statute,
      or whatever is required (e.g. consent) to avoid triggering it has been
      addressed.

- [ ] **5. Notice/consent language.** Confirmed: any required notice or
      consent language for residents, owners, and/or vendors has been
      drafted and, where required, sent.

- [ ] **6. Existing agreements reviewed.** Confirmed: management agreements
      and vendor contracts have been checked for whether this is already
      covered or needs an update.

Once all six are checked, tell me and I'll have Mason do a final pass
confirming the actual build matches what's checked off here — that's the
last step before this connects to a real inbox.

---

## Status (2026-08-16) — RESOLVED

All six items confirmed. The two follow-up questions Mason's first final
pass required are now answered and built:

1. **Item 1 (privilege boundary):** counsel's inclusion covers everything
   EXCEPT subpoenas, attorney/counsel correspondence, and demand letters —
   those stay excluded from automated processing (held for a human).
   Fair Housing/HUD/CRD complaints also stay held (Peter's explicit
   instruction, confirmed separately). Litigation/lawsuit/small claims
   mentions and the code-compliance/regulatory category ARE included
   (tagged, processed normally).
2. **Items 3/5 (notice):** no notice required — applies to residents,
   owners, AND vendors, all three.

Mason ran a second final-pass confirmation against the actual implemented
code (`projects/hub/email-intake/lib/privilege-keywords.js`) and the full
13-case test suite (`projects/hub/email-intake/test/run-tests.js`, all
passing) and confirmed the boundary is coherent, with one accepted edge
case noted (a tenant self-reporting an already-filed small claims case
number gets tagged rather than held — flagged for occasional human
spot-check, not a defect).

**Legal review is fully closed.** What's still needed before this connects
to a real inbox is governance/engineering work (a relevance filter, a data
storage design, a formal spec + risk assessment, then a shadow period) —
see Asimov's 2026-08-16 governance check-in for that list. Not a legal
question anymore.
