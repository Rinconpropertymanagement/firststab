# Property Brain — LeadSimple Accuracy Test

> **Public copy.** Applicant names, property addresses and LeadSimple links have been removed from
> this version and replaced with case numbers; the key is kept privately by Rincon.

The same cheap test the maintenance-history tool went through, run against a different
kind of record: can the AI accurately read "what stage is this applicant's case in, what
tasks got done, what got skipped, and what do the notes fields say" out of real LeadSimple
Application Screening cases?

No new software gets built for this. It's just files in this folder, plus the extraction
pipeline Q already built (`projects/hub/leadsimple-property-brain/`).

## The two rules that make or break this

1. **Write the answer key BLIND — before the AI's version is looked at.** Open the case
   directly in LeadSimple, write down what you see with your own eyes, before anyone runs
   extraction on it or shows you the AI's output. If you look at the AI's version first,
   you'll unconsciously agree with it and the results become meaningless.
2. **The AI that extracts never grades itself.** A different person (or a different AI
   session with no memory of the extraction run) checks the AI's work against the sealed
   answer keys.

## What's different from the maintenance version

- **No export step.** Maintenance tickets got copied into text files first. LeadSimple
  cases don't need that — the data lives in LeadSimple itself, and everyone filling out an
  answer key already has a LeadSimple login. You just click the case's link and look at it
  on screen.
- **The 20 cases are already picked**, in the tracking sheet below — not something you need
  to go choose yourself. Case selection had to be done by scanning the *content* of custom
  fields across the whole account first (to find the one unusual "Positive Landlord
  Reference" entry and the two cases that used the "comments" box, out of 2,158 total
  cases) — that's not something you can eyeball by browsing LeadSimple's list view.
- **What's being tested is narrower than maintenance.** This tool only ever records four
  kinds of fact per case — never a summary, a risk score, or a recommendation about the
  applicant:
  1. **What stage the case is in right now** (LeadSimple keeps no history of past stages —
     so this only tests "what stage is it in today," not "when did it get there.")
  2. **Which tasks are marked complete** (and when)
  3. **Which tasks are marked skipped**
  4. **What the custom fields say** — mostly short dropdown/date answers, plus the two
     free-text fields ("Positive Landlord Reference" and the general "comments" box)

## Your part — filling out the 20 sealed answer keys (nobody else can do this for you)

### Step 1 — For each of the 20 cases in the tracking sheet below (10–15 min/case)

1. Click the case's LeadSimple link (opens straight to that case — you'll need to be
   logged into LeadSimple).
2. Copy `answer-key-template.md` and fill it out **from what you see on screen, right now,
   with your own eyes. No AI help, not even to summarize, not even to double-check
   yourself.**
3. Name the file to match the case number in the tracking sheet, e.g. `case-01-answer-key.md`.
4. **Do not look at any AI-generated extraction for this case before you've filled out and
   saved this file.** Once it's saved, that case is sealed — move to the next one.

**One rule specific to the two free-text fields ("Positive Landlord Reference" and
"comments"):** write down what the field says *in your own words* — a short paraphrase,
not a copy-pasted sentence. Two reasons: (1) the AI being tested is required to paraphrase
too, never quote verbatim, so this keeps the comparison fair; (2) this project folder isn't
a secure system the way LeadSimple itself is, so the fewer verbatim applicant quotes that
end up sitting in a plain text file here, the better. "Standard positive reference" or "the
applicant said their rent will come from a housing voucher" is exactly the right amount of
detail — not the exact sentence.

### Step 2 — Once all 20 are sealed, tell whoever is running extraction

Don't open any AI output before every answer key is saved. Once they're all sealed, say so
— that's the signal that grading can start.

## My part, once all 20 answer keys are sealed

- **Step 3 — Run extraction.** Q's pipeline (already built, not run yet against these
  cases as of this writing) reads each case directly from LeadSimple and produces the same
  four kinds of claim, citing a specific source for every one, saying "unknown" rather than
  guessing wherever LeadSimple itself doesn't have the answer (e.g., it will never guess a
  date for when a case entered its current stage, because LeadSimple doesn't track that).
- **Step 4 — Grade it, blind.** Someone who did **not** write the sealed answer keys and
  is **not** the same session that ran the extraction scores the AI's output against each
  sealed key, case by case, using the same five-way scale the maintenance test used:

  | Rating | Meaning |
  |---|---|
  | Fully correct | Matches the sealed answer key exactly |
  | Partial | Right idea, but incomplete or imprecise |
  | Wrong | Answer key says one thing, AI said another |
  | Missed | AI didn't report something the answer key says is there |
  | Wrong source | AI's citation/link points to the wrong record or field |

  Grade each case as a whole across its four claim types (stage / tasks completed / tasks
  skipped / field values) — the same "one ticket, graded together" approach the
  maintenance test used, just with LeadSimple's four fact-types standing in for
  maintenance's event/decision/outcome/recurrence.

- **Step 5 — Decide.** Pre-committed thresholds, so nobody can rationalize after seeing the
  numbers — same table the maintenance test used:

  | Result | Verdict |
  |---|---|
  | ~90%+ correct | Worth building on — proceed |
  | 70–90%, or errors cluster in one type | Viable, but the weak spot stays permanently human-reviewed |
  | Under ~70% | Not ready — fix how the source data gets recorded, retest |

  **One additional bar specific to this domain, set by Asimov (governance) before this
  tool is allowed anywhere near real, ongoing applicant data:** regardless of the overall
  percentage above, this test must come back with **0% Missed and 0% Wrong-source** before
  Application Screening can even be considered for "shadow mode" (the AI quietly running in
  the background on new, real applicants while a human checks every single result). A
  Missed or Wrong-source result on even one item means that gate isn't cleared yet, even if
  everything else scores well — bring the graded results back to Asimov either way.

## The case Q already tested against — confirmed and excluded

Q ran a test extraction against one real case while building the pipeline (it is referenced in
TARS's test report). Seeing the AI's own output for a case before writing its answer key would
bias that case's grade, so it needed to be identified and kept out of this sample.

No test-report file existed anywhere in the repo to look this up from, so it was confirmed
directly by pulling the live LeadSimple record and matching it on both its process ID and its
applicant and property details (kept privately). **This case is confirmed excluded — it is not
one of the 20 below**, and every case in the tracking sheet was selected from the same live
pull, checked against that ID directly rather than by name matching alone.

## A gap in the "minor variation" bucket, noted rather than hidden

The spec asks for "several" cases from the ~10% of Application Screening tasks that carry
minor variation in their wording (dates, verification shorthand, property-specific notes)
rather than pure boilerplate. LeadSimple's API has no way to filter tasks by which case
they belong to, so finding these required pulling a window of recent account-wide task
activity and matching it back to known cases by hand — a live, rate-limited scan, not an
instant lookup. To keep this test moving, that search was kept short rather than run
exhaustively: **only 2 cases were confirmed this way**, not the fuller "several" the spec
describes. Both are real, solid examples — cases #4 and #5 in the tracking sheet below,
where actual task wording (e.g., "Review Credit and write average score in notes") departs
from the standard repeated template. If a fuller minor-variation set matters before this
test is treated as final, that search can be picked back up later — flagged here rather
than quietly presented as complete.

## Tracking sheet — the 20 selected cases

All 20 were pulled live from Rincon's real LeadSimple account. "Boilerplate" cases were
spread across every stage a case can end in (not just "Completed") and across nearly the
full history of the account (2022–2026), on purpose — a sample of only recently-closed,
successfully-completed cases would give flattering, useless numbers, the same reason the
maintenance test didn't just grab the 10 most recent tickets.

| # | Case | Bucket | Stage | LeadSimple link | Answer key sealed | Extracted | Graded |
|---|---|---|---|---|---|---|---|
| 1 | Case 01 (3 applicants) | Outlier (non-boilerplate landlord reference) | Completed | (link kept privately) | | | |
| 2 | Case 02 (1 applicant) | Comments field (housing-voucher / Section 8 mention) | Tenant didn't take home | (link kept privately) | | | |
| 3 | Case 03 (2 applicants) | Comments field (credit-score note) | Tenant didn't take home | (link kept privately) | | | |
| 4 | Case 04 (2 applicants) | Minor-variation tasks | Completed | (link kept privately) | | | |
| 5 | Case 05 (3 applicants) | Minor-variation tasks | Completed | (link kept privately) | | | |
| 6 | Case 06 (1 applicant) | Boilerplate | Completed | (link kept privately) | | | |
| 7 | Case 07 (2 applicants) | Boilerplate | Completed | (link kept privately) | | | |
| 8 | Case 08 (1 applicant) | Boilerplate | Completed | (link kept privately) | | | |
| 9 | Case 09 (not named in the source) | Boilerplate | Completed | (link kept privately) | | | |
| 10 | Case 10 (1 applicant) | Boilerplate | Denied | (link kept privately) | | | |
| 11 | Case 11 (2 applicants) | Boilerplate | Denied | (link kept privately) | | | |
| 12 | Case 12 (2 applicants) | Boilerplate | Denied | (link kept privately) | | | |
| 13 | Case 13 (2 applicants) | Boilerplate | Tenant didn't take home | (link kept privately) | | | |
| 14 | Case 14 (1 applicant) | Boilerplate | Tenant didn't take home | (link kept privately) | | | |
| 15 | Case 15 (1 applicant) | Boilerplate | Tenant didn't take home | (link kept privately) | | | |
| 16 | Case 16 (3 applicants) | Boilerplate | Applicant Non-Responsive | (link kept privately) | | | |
| 17 | Case 17 (1 applicant) | Boilerplate | Applicant Non-Responsive | (link kept privately) | | | |
| 18 | Case 18 (1 applicant) | Boilerplate | Applicant Non-Responsive | (link kept privately) | | | |
| 19 | Case 19 (2 applicants) | Boilerplate | Rented to Someone Else | (link kept privately) | | | |
| 20 | Case 20 (1 applicant) | Boilerplate | Rented to Someone Else | (link kept privately) | | | |

**Composition summary:** 1 outlier + 2 comments + 2 minor-variation + 15 boilerplate = 20
cases, spread across 5 different stages (Completed, Denied, Tenant didn't take home,
Applicant Non-Responsive, Rented to Someone Else) and across 2022–2026, not clustered in
recent, easy, already-closed-out cases.

**One thing worth a second look, not a bucket change:** case #20 has "(Section 8)" in the applicant's own name field in LeadSimple, unrelated to
why it was picked (it's an ordinary boilerplate case by its custom-field content). The
extraction tool never reads or extracts anything from that name field — only stage, tasks,
and the two designated custom fields become claims — so this doesn't change what's being
tested, but it's worth knowing it's there if this case comes up in review.
