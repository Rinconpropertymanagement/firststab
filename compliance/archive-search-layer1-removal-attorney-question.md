# Archive Search — Quick Follow-Up: Removing the Keyword-Only Layer

**Prepared for:** Peter McKenzie, Rincon Management, to forward to outside counsel
**Date:** 2026-09-12
**Purpose:** one narrow, quick question — not a new review of anything you've already approved.

---

Archive search actually uses **two** checks to decide whether an email is excluded/flagged, not one:

1. The AI question you reviewed and approved earlier tonight (adverse treatment, unresolved accommodation, discriminatory preference — not mere mention).
2. A separate, older, automatic keyword scanner: it flags immediately on matching most protected-characteristic-related words anywhere in the email, with no judgment or context at all. Either check flagging is enough to flag the email.

That second check is why real numbers tonight are still high even with your approved fix in place — it flags on mere mention, the exact standard your opinions have repeatedly said the law doesn't require.

**Proposed change, for archive search only:** stop using the keyword-only check. Rely solely on the AI question you already reviewed.

**The question:** given your consistent position that mere mention of a protected characteristic isn't itself a Fair Housing concern, do you approve removing this keyword-only layer for archive search specifically?

**The honest tradeoff:** doing this means archive search's flag/clear decision rests entirely on the AI's judgment, with no independent keyword backstop underneath it. The AI still defaults to flagging on any technical failure (timeout, error) — but if it runs successfully and simply reaches the wrong conclusion, there's no second check catching it, which there is today.

This does not touch any other tool — the keyword check keeps working exactly as it does today everywhere else it's used.
