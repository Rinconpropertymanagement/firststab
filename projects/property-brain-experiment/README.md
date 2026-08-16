# Property Brain — Experiment #1

The cheap test to answer one question before anyone builds anything: can AI accurately
pull "what happened, what we decided, and whether it worked" out of your real, messy
maintenance history?

No new software gets built for this. It's just files in this folder.

## The two rules that make or break this

1. **Write the answer key BLIND — before any AI sees the ticket.** If you look at the
   AI's version first, you'll unconsciously agree with it and the results become
   meaningless. Ground truth first, always.
2. **The AI that extracts never grades itself.** A different AI (or you) checks its work.

## Your part (nobody else can do this for you)

### Step 1 — Pick 10 tickets (30–45 min)
Don't grab the 10 most recent — easy tickets give flattering, useless numbers. Pull this exact mix:

| Count | Type | What to look for |
|---|---|---|
| 3 | Routine fixes | One vendor visit, clear problem, fixed, closed |
| 3 | Messy, multi-visit | Callbacks, changed diagnosis, multiple vendors, repeat tries |
| 2 | Owner-decision | Owner approved/declined/deferred something, esp. in casual language ("just patch it for now") |
| 1 | Known recurrence | A problem that came back later as a new ticket — include **both** tickets' material |
| 1 | Went sideways | A dispute, NTE overrun, insurance claim, or angry owner/resident thread |

Log them in the tracking table at the bottom of this file.

### Step 2 — Export the raw material (1–2 hrs)
One folder per ticket in this directory (`ticket-01/`, `ticket-02/`, …). Copy-paste into text
files is fine — ugly is the point, that's how the AI will actually see your data day to day.
Per ticket: the full message thread, vendor notes/diagnoses, invoices, photos (with dates),
owner emails/texts (this is where decisions hide), related inspection findings.

**Before anything goes in a folder:** redact SSNs, bank/payment details, anything from an
attorney. Names/addresses — your call, but keep substitutions consistent if you use them.

### Step 3 — Write the answer key, BLIND (2–3 hrs, ~10–15 min/ticket)
For each ticket, from memory and the records, **zero AI help, not even to summarize.**
Copy `answer-key-template.md` into each ticket folder and fill it out. Seal it (just don't
open the raw ticket AI extraction until you're done with all 10) before moving to Step 4.

## My part, once you've sealed all 10 answer keys

- **Step 4 — Run extraction.** I read the raw material and produce a structured summary per
  ticket, citing a source for every claim, saying "unknown" rather than guessing.
- **Step 5 — Grade it.** A different AI session (or you) scores my output against your sealed
  answer keys and times how long your own verification actually takes.
- **Step 6 — Decide.** Pre-committed thresholds, so nobody can rationalize after seeing the
  numbers:

| Result | Verdict |
|---|---|
| ~90%+ correct, review under ~2 min/ticket | Worth building on — proceed |
| 70–90%, or errors cluster in one type | Viable, but the weak spot stays permanently human-reviewed |
| Under ~70% on decisions or recurrence | Not ready — fix how the source data gets recorded, retest |

## Tracking sheet

| # | Ticket ref | Category | Answer key sealed | Extracted | Graded |
|---|---|---|---|---|---|
| 1 | | Routine | | | |
| 2 | | Routine | | | |
| 3 | | Routine | | | |
| 4 | | Messy | | | |
| 5 | | Messy | | | |
| 6 | | Messy | | | |
| 7 | | Owner decision | | | |
| 8 | | Owner decision | | | |
| 9 | | Known recurrence | | | |
| 10 | | Went sideways | | | |
