# Archive Search — What You Need to Know Before You Use It

**Audience:** The small group of staff with Archive Search access (~8 people).
**Purpose:** Required by Rincon's outside counsel as a condition of approving Archive Search's design (see `compliance/archive-search-fair-housing-outside-counsel-opinion.md`, safeguard #4 — "make clear through policy and training that the presence of information in Archive Search does not establish that it may lawfully be considered in every housing decision").
**Status:** Draft, wording-complete. The escalation section below correctly describes the "Report a Fair Housing concern" action as actually built — see `archive-search-escalation-mechanism-spec.md`'s own Status line: the mechanism is approved, built, and tested (its governance/legal review is fully resolved, `compliance/archive-search-escalation-mechanism-review.md`). What's still missing is the *Report button itself* — the database and routing all exist, but there's no clickable button yet, because Tron's search UI hasn't been built. **This note must not go out to staff until (1) the search UI with a real Report button exists, and (2) this code is actually deployed and running on Rincon's live server** — neither has happened as of this writing.

---

## What Archive Search Is

Archive Search lets you search Rincon's old email — years of correspondence with tenants, owners, and vendors — the same way you'd search anything else. It's a lookup tool. That's all it is.

It is **not** a decision-making tool. It doesn't score, rank, flag, or recommend anything about a tenant or applicant, and it doesn't tell you whether to renew a lease, deny an application, or take any other action. It just finds old messages that match what you searched for.

Before anything becomes searchable, an automated screen pulls out attorney/legal material and anything that looks like it touches on race, disability, family status, and other protected characteristics. That screen is not perfect — nothing that reads quarter-million emails automatically ever will be — which is exactly why the rule below matters.

## The One Rule That Matters Most

**Finding something in Archive Search does not make it OK to use.**

An old email showing up in a search result is not, by itself, a fair or legal reason to treat a tenant or applicant differently.

Our attorney's own reasoning here is worth knowing: simply *knowing* something about a tenant — that they have kids, use a housing voucher, requested an accommodation, use a wheelchair, speak a different language at home, are pregnant, or fall into any other protected category — is not a Fair Housing problem by itself. Property managers know things like this all the time; that's normal. The problem is treating someone differently *because of* it. Archive Search will surface ordinary information like this, and that's fine — it only becomes a problem if it gets used as a reason to decide who gets a unit, who gets approved, or who gets treated differently.

If you're weighing something with real consequences for a tenant or applicant — a renewal, a denial, an accommodation request — make that call the way you normally would, through our regular process. An email you happened to find in a search is one data point, not an authoritative answer. Don't treat it as the reason for the decision.

## Old Email Can Be Wrong

"Real historical email" doesn't mean "reliable." Emails in the archive can be:

- **Out of date** — true five years ago, not necessarily true now.
- **Just wrong** — people guess, assume, or repeat secondhand information that turns out to be false.
- **Out of context** — a line pulled from the middle of a longer conversation can read very differently than it did with everything around it.

Treat anything you find the way you'd treat something you overheard secondhand: worth being aware of, not worth relying on.

## If You Find Something That Looks Like a Real Fair Housing Problem

Most of what turns up will be completely routine — maintenance, lease questions, payment history. Once in a while you may come across something that looks like an actual Fair Housing concern: an email suggesting someone was, or should be, treated differently because of race, disability, family status, national origin, or another protected characteristic.

If that happens:

1. **Stop.** Don't use that email as the basis for anything.
2. **Don't rely on it.** Don't factor it into any decision, conversation, or action involving that tenant or applicant.
3. **Use the "Report a Fair Housing concern" button**, right where you found it, and write a short note on what you saw and why it concerns you. There's no single person you need to track down and tell — reporting it is a system action. The moment you submit it, that conversation is pulled out of search for everyone (not just you) and stays out until a trained admin has reviewed it. An email goes out immediately to the Director of Operations and Peter so it doesn't sit unnoticed. The admin then decides what happens next.

You do **not** need to report every email that simply mentions a protected characteristic — per the section above, that will happen often and isn't itself a problem. Flag it when it looks like actual discriminatory treatment or something clearly inappropriate — not just a passing reference.

## What Being Searchable Does and Doesn't Mean

Archive Search used to automatically exclude anything that looked like it involved an attorney, a lawsuit, or another legal matter, permanently, with no way to release it. That blanket exclusion has been removed, based on our outside attorney's real, written opinion on this exact question (2026-09-13) — the underlying emails were already visible to everyone with access to the shared inbox this tool searches; hiding them from this particular search box didn't actually add any real protection.

Two things our attorney specifically asked to be stated plainly, in his own words, so nobody misreads what a search result does or doesn't mean:

> Inclusion of a communication in Archive Search does not constitute a determination by Rincon that the communication is nonprivileged, nonconfidential, discoverable, or subject to production.

> Automated classification, indexing, searchability, employee access, or failure to restrict a communication within Archive Search does not constitute an intentional decision by Rincon to waive any attorney-client privilege, work-product protection, confidentiality right, or other applicable protection.

In plain terms: a thing showing up in search doesn't mean it's "cleared" of being privileged, and it doesn't mean Rincon gave up any legal protection over it. If you come across something that looks like real attorney correspondence or a genuine legal matter, treat it the same careful way you'd treat any sensitive internal document — don't forward it around, don't rely on it for a decision, and if you're unsure what to do with it, ask Peter or the Director of Operations directly rather than through this tool. There is no in-tool "report" button for this category specifically — it's handled the normal way, outside the software, the same way any other sensitive document at Rincon would be.

## Quick Summary

- Archive Search looks things up. It doesn't decide anything.
- Finding something doesn't mean you can use it in a decision.
- Old email can be outdated, wrong, or missing context.
- Looks like a real Fair Housing problem? Stop. Don't rely on it. Use the **Report** action — it immediately pulls the conversation from everyone's search results while an admin reviews it.
- Looks like real attorney/legal correspondence? Being searchable doesn't mean it's not privileged. Handle it carefully and talk to Peter or the DO directly — not through the tool.
