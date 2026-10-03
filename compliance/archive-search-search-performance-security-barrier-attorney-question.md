# Archive Search — Quick Question: Search Performance vs. the Content-Exclusion Protection

**Prepared for:** Peter McKenzie, Rincon Management, to forward to outside counsel
**Date:** 2026-09-24
**Purpose:** one short, specific question — not a re-review of anything already approved.

---

Archive Search's underlying database view (`missive_message_intake_search_safe`) is the single gate between a raw email archive and what an authorized searcher can see. It excludes three categories of content: held/privileged legal correspondence, conversations with an open or confirmed Fair Housing escalation, and conversations a reviewer has specifically suppressed. That view carries a Postgres setting called `security_barrier`, whose specific job is to stop a user's own search term from ever being evaluated against excluded rows before the exclusion logic runs — in plain terms, it prevents a search from being able to detect, through timing or error behavior, that something exists in a category the searcher isn't supposed to see, even though the actual content never appears in results.

**The problem:** that same protection is also why full-archive text search is currently too slow to complete in production — Postgres has to fully process every exclusion check across the whole archive before it can even start checking whether a search term matches, on every single search. A bounded, recent-history search (last 12 months, say) works fine and needs no legal input; searching the full multi-year archive does not.

**Two direct fixes exist and were both rejected internally already**, without asking you: removing the protection entirely, or marking the search-matching operation as provably safe across the board. Both would reopen the exact existence-detection risk the protection was built to close, for the sake of speed.

**The fix Rincon's own governance and legal reviewers think is actually sound:** build the full-text search index over a separate, continuously-updated copy of the archive that only ever contains content currently eligible for search — excluded content (held, escalated, suppressed) is never physically present in that copy to leak from, at all, under any circumstance. If the copy stays perfectly in sync with the real exclusion state, this is a stronger guarantee than today's architecture, not a weaker one.

**The question:** is this the kind of decision Rincon's own engineering and governance judgment can make internally — since no content becomes visible that wasn't already going to be visible — or does it need your review as its own matter, given it touches the mechanism that keeps privileged and Fair-Housing-sensitive content from being detectable at all, not just what content is shown? And if it does need your input: does the "separate, synchronized, exclusion-only copy" approach address the concern adequately, or would you want specific conditions attached (for example, a guarantee about how quickly the copy reflects a new exclusion, or periodic verification that excluded content never appears in it) before Rincon builds it?
