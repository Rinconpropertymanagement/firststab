# Work Order Note Alerts — Governance Review: the optional job title and description in the alert email

**Written by:** Asimov (governance). **Date:** 2026-10-16. **Covers:** the design-stage ruling, the re-ruling after Peter's four answers, the final review of build commit `0092ffe`, and the final review of the second fix round, commit `ce30374` (Section 16), all on `feature/work-order-alert-description`; the final review of the third fix round, commit `2ab3d53`, with Peter's later overrides of the shadow week and the faster check (Section 17), and the final review of the fourth fix round, commit `c781a1b`, with Peter's replies to Jarvis's three questions (Section 18, which governs where it differs from the sections before it).

## Verdicts at a glance (final review of the fourth fix round, 2026-10-16, commit `c781a1b`)

| Step | Verdict | In one line |
|---|---|---|
| (a) Deploy with the mode OFF | **APPROVED WITH CONDITIONS** | Dormant code: with the mode off or unset the email is byte-identical to today's (TARS 3,784 comparisons against the live code) and the new modules only load. Tests, security and chaos re-runs are in and clean on this exact commit. Open before the deploy: Judge's sign-off (not received), Scotty's Node and load check and a file-scoped deploy that cannot undo the Missive exclusion, the unseen tail of Viper's list (documents only), an honest PR table, and Peter's separate yes to merge and to deploy (Section 18.5 a). Deploying is not switching on. |
| (b) Switch ON | **APPROVED WITH CONDITIONS** | No remaining governance objection to the code, design or tests at `c781a1b`. I hold the activation confirmation until these are true: Judge's sign-off; the deploy done and the five runtime files confirmed by hash; the Missive exclusion still on the server after the deploy and seen excluding the next real alert; Peter's sign-off on the 12 sample emails and the word-list diff; his fresh Mason, as-built, miss-acceptance and later-decision answers at ON; his separate yes (Section 18.5 b). |
| (c) The 7-day SHADOW week and the faster real-work-order check | **OVERRIDDEN BY THE OWNER** | Peter declined both on 2026-10-16 (as relayed, quoted in Section 17.4). Not run, not met, no measurement. Never to be described as done. |

**Four owner overrides are in force and must never be described later as met:** attorney review (GOVERNANCE.md Rule 6) was overridden when Peter skipped Mason's review; the 30 or 90 day shadow of Rule 7 was not applied; the 7-day shadow week of Rule 6 was declined; and the faster read-only check over the past work orders was declined. **A fifth owner decision is recorded in Section 18.4:** Peter's "ignore and treat as normal" on the repository-visibility caution (my condition O-4), with the push-time re-ask. See Sections 11, 17.4 and 18.4.

Nothing in this document is a clearance to go live. Only Peter merges, deploys or switches anything on, each with his own separate yes.

**How to read this document.** This is the file that comments in the code (`approval-briefing/lib/work-order-notes-alert.js`, `lib/work-order-summary.js`, `lib/work-order-text-screen.js`) and the other compliance files point at. Where it **summarises** an earlier ruling rather than quoting it, the heading says "as summarised in the build brief". Nothing is presented as verbatim unless it is in quotation marks. Peter's four questions and his reply are verbatim (Section 4). Section numbers are referenced from other files (the ingestion exclusion branch cites Section 8), so they are kept stable; new material is added as Sections 16, 17 and 18.

**Related documents:** `work-order-note-alerts-governance-review.md` (first review of the notes alert), `work-order-note-alerts-content-check-removal-decision-resolution.md`, `work-order-note-alerts-mason-override-decision-resolution.md`, `work-order-note-alerts-data-inventory.md` (Rule 4, with the 2026-10-16 addenda), `work-order-note-alerts-description-decision-resolution.md` (Peter's decisions), `projects/hub/work-order-notes-alert-SPEC.md` (Section 6A).

**A note on what this document leaves out.** The security and red-team reports contain exact attack strings. They are deliberately not reproduced here, because the repository is public today (checked again for this review, Section 16.1) and its visibility must be fixed before anything is pushed. Findings are described by class, never by example string. No slur appears in this document.

---

## 1. What the block does

When Latchel reports a new work order at a property that has a maintenance note on file, the Hub already emails that property's pod inbox (Solimar or Faria) a fixed-template alert. This feature can add one short block to that email, "What the work order is":

- the job's own **title** (up to 100 characters) and **description** (up to 300), quoted after cleaning, and only when a local word-list screen finds nothing;
- an automatic **category guess** from a fixed list of 10 labels, and a **priority line** copied from Latchel's own emergency and urgent flags;
- one fixed last line: "(Quoted as typed in Latchel. Not checked for names, phone numbers or access codes. Internal use only.)"

Otherwise the block is one fixed sentence that points the reader at the Latchel job and ticket number already printed in the email. The recipients are internal staff inboxes only (never a tenant, owner or vendor). There is **no AI anywhere in this feature**: the screen is a word list that runs on the Hub server, nothing from the job text is sent to Anthropic or anywhere else, and no model key is used. The email is a copy that this system cannot control once sent (pod inboxes, Missive, the noreply sent folder).

Modes: `off` (default; the email is byte-identical to today's), `shadow` (the whole local pipeline runs and one counts-only audit row is written, but the email that goes out is identical to `off`), `on` (the block is in the email; takes effect only with the ingestion interlock, Section 8).

## 2. Tier table (the three permission tiers)

| Action | Tier | Why |
|---|---|---|
| Clean and screen the job title and description locally; build the block in memory | 1 (Auto) | Internal, reversible, stores no text, sends nothing anywhere, makes no decision about a person |
| Write the one counts-only audit row (job id, property id, result, cause, flags; no category names after R3-1) | 1 (Auto) | Counts only. Category names were allowed here by my earlier rulings and are withdrawn in Section 16.4 |
| Read-only Latchel `getJob` lookup when the job in hand has no description field | 1 (Auto) | Read-only, one call, existing connector, result used for display only. Runs only for a plain-digit job id and the answer must carry the same id (condition W2, verified) |
| Skip a duplicate delivery of a job that is already being handled (shadow and on only) | 1 (Auto) | Prevents a second identical email; expires after 5 real minutes on a monotonic clock |
| Send the alert to the pod shared inbox with the block (mode `on`) | 1 (Auto), gated | Internal-staff-only recipient, fixed template, behind the local screen; conditional on every item in Section 7 and on Peter's separate yes |
| Hold the block (any match, any error) | 1 (Auto) | Fails closed: the whole block is replaced by one fixed sentence; the rest of the alert still goes out |
| Decide whether a held block should be read, or act on its content | 3 (Human Only) | Nothing in this feature acts on the text (Rule 9). A person opens the Latchel job |
| Switch the mode to `shadow` or `on`; extend or loosen the term list; merge; deploy | 3 (Human Only) | Peter's explicit yes each time; loosening is a Critical Rule 6 change |

No tenant, owner or vendor receives anything from this feature, so Tier 2 (draft and wait) does not apply to the send. No housing decision is made or influenced (Rule 9, Section 6).

## 3. Asimov's earlier rulings (as summarised in the build brief)

The full text of these rulings was given in earlier sessions and is not reproduced here. Only the summary that Jarvis relayed in the build brief is recorded.

- **Design-stage ruling (summary).** The optional block was allowed only behind a required safeguard that fails closed: a keyword scan using the shared protected-class list, a contextual rescue for the few ordinary words, and an AI second look at the text. Counts-only audit, nothing stored, a shadow period, Mason's review and Peter's sign-off on rendered samples before switching on.
- **First final ruling (summary).** Approved with conditions, including the AI second look and Mason's review.
- **Previous build (summary).** A first version was built with the AI second look and the contextual rescue (commit `cae5a2491`); TARS passed it and Judge approved it. Asimov approved it with conditions and listed open findings (a) to (i), which Section 12 tracks.

Peter's answers on 2026-10-16 changed the premise of those rulings. Asimov then re-ruled (Section 5), and after the build, the test, security, red-team and chaos reports, gave the first final review (Section 15) and, after the second fix round, the review in Section 16.

## 4. Peter's four questions and his reply, 2026-10-16, verbatim

Jarvis put four questions to Peter in chat and relayed them, with Peter's reply, to Asimov. They are reproduced here exactly as relayed. Asimov did not see the chat itself, so this is the relayed text, not a transcript.

1. **Question 1:** "Do you accept the AI second look on this text? You said no AI for the property notes. This is different text. My recommendation is yes, and the alternative is no description at all."
2. **Question 2:** "Do you accept that a miss is possible? If both checks miss something, a tenant's words about health or safety could land in the shared pod inboxes. Phone numbers, emails and gate codes typed into the description would also pass through. I'd recommend removing phone numbers and email addresses from the text as well."
3. **Question 3:** "Mason's review: Asimov requires it. Skipping it needs your explicit say-so, and I'd recommend keeping it."
4. **Question 4:** "Length: Asimov's limit is 300 characters, up to 500 if the shadow week shows 300 is too short. I'd start at 300."

**Peter's reply, verbatim:** "1. no 2. yes i accept 3. skip this review 4. ok"

What each answer means, as applied in the build (the build brief's reading, which I follow):

1. **"no"**: Peter does NOT accept an AI second look on the job title and description. No AI of any kind may read this text, in any mode: no model self-check, and no contextual-rescue call for the ordinary words either (that classifier is an AI too). Ambiguous terms simply hold. Nothing from the job text may be sent to Anthropic in `off`, `shadow` or `on`.
2. **"yes i accept"**: a miss is possible and cannot be fully measured; personal details typed into the description (tenant names, phone numbers, e-mail addresses, unit numbers, gate and lockbox codes) pass through unscreened; a copy of the email lives in the pod inboxes, Missive and the sent folder. Peter did not take the recommendation to strip phone numbers and e-mail addresses, so they are NOT stripped.
3. **"skip this review"**: Peter overrides Mason's (Fair Housing and legal) review for this feature. It is recorded in Section 10 and is re-confirmed with the checklist in front of him before ON.
4. **"ok"**: description 300 characters, title 100.

**Four things in the wording that the earlier version of this record glossed over, and that I now record plainly:**

- **Question 1 offered two options: the AI second look, or "no description at all".** The feature as built is a third option, a local word list with no AI, in which ordinary words such as a paint colour also hold. That option was not one of the two put to Peter in that question. His answers 2 and 4 (accepting misses, agreeing the length) point to wanting the description to exist, and that is how the work has been read, but the as-built option, with its cost, has to be put to him in plain words before the shadow is switched on (W12) and again before ON (Section 7). Shadow shows nothing to anyone, so proceeding to it on this reading is low risk. ON is not.
- **Question 2 spoke of "both checks".** Peter answered it in the same reply in which he declined the second check. What he accepted is therefore a miss with one layer, the word list. The miss rate is not known until the shadow week's human second look measures it, so the acceptance is re-confirmed with the measured numbers before ON.
- **Question 3 as relayed does not list what Mason would have checked.** I do not know whether the checklist (Section 10) was put to Peter before or after he said "skip this review". The override stands for building, deploying OFF and running the shadow week (CLAUDE.md rule 3), and it is re-confirmed with the checklist in front of him before ON. Showing him the checklist at the moment he is asked for the shadow yes costs nothing and removes the doubt.
- **Question 4 does not contain "about 600".** That figure came from earlier discussion in the build brief, not from this question. Peter's "ok" covers the 300 and 100 limits only. He has not been told the real worst-case block length (733 characters, Section 16.1) and has not accepted it.

Not yet answered: whether to stop the Hub's Missive intake from copying Work Order Alert emails into Hub tables (Section 8).

## 5. Asimov's re-ruling, 2026-10-16 (as summarised in the build brief)

**Verdict at the time: APPROVED WITH CONDITIONS.** The conditions are binding on the build and on any switch-on. Sections 15 and 16 record how the build measures up and change the verdict by step.

### 5.1 What changes because of Peter's answers

| Before (first build) | Now |
|---|---|
| Keyword scan, then contextual rescue (AI), then an AI second look | One local screen. No model call of any kind. The AI second-look module is deleted, not left dormant |
| Ordinary words (white, black, blind, diagnosis, diagnosed, too old, too young for) could be rescued in context | They hold, like every other term. "Paint the walls white" is held. That is the cost Peter accepted |
| Held block showed a "held for privacy review" sentence and a category line | One fixed sentence, no category line, no priority line, no byte derived from the text. The old phrase is retired everywhere because it implied a human review that did not happen |
| Unassigned pod used the same held sentence | Its own sentence ("no pod assigned yet"), because nothing was read or checked |
| Shown block ended at the description | Shown block ends with the fixed line "Not checked for names, phone numbers or access codes", so the email never implies a clearance that does not exist |
| Shadow week measured AI results | Shadow week measures local-screen counts only; the miss rate is estimated by a human second look at a sample |

### 5.2 Binding requirements (summarised from the build brief)

| # | Requirement |
|---|---|
| 1 | Remove every AI path. Delete the AI check module and every test, stub, fixture, comment and env note that existed only for it. No import, call or transitive load of the model SDK, the shared claim check, the contextual classifier, or the notes check/classifier. No dependence on `TIER_B_CONTEXTUAL_CHECK_ENABLED` in either direction. Frozen shared files stay untouched |
| 2 | New local screen: one synchronous, side-effect-free function returning `cleared`/`held`, a cause, category names from a fixed vocabulary, `common_word_only`, and a version. Uses only `scanText` and `TERMS_VERSION` from the shared list (read-only) plus a feature-local list. ANY match holds, including the seven ordinary-word terms. A test seam for a throwing screen |
| 3 | Prove "no AI, nothing leaves the server" three ways: fresh-process import graph; blocked network with a dummy key and every AI switch on, over all three modes; static source scan |
| 4 | Fail closed and self-test: any exception, non-text input, regex failure or time-guard trip holds with cause `check_error` (the alert still sends). Start-up known-answer self-test (12 or more must-hold, 12 or more must-pass); a wrong answer makes every call a scanner error and logs one constant line |
| 5 | Cleaner removes (not spaces) invisible characters: default-ignorable, control, format, private-use, surrogates, U+2800, U+FFFC. Removing joiners splits emoji sequences; accepted. (Amended by W4 and W7: the screen also reads a second copy in which each removed piece becomes a space, and unassigned code points are removed too) |
| 6 | Cleaner neutralises links: explicit scheme denylist, `//host`, `www.`, bare domains with path/query/port, 40 or more TLDs, shorteners, IP hosts, punycode. Plain e-mail addresses, phone numbers, times, dates untouched |
| 7 | Cleaner invariants: output never matches its own link detector; idempotent; 10,000 or more generated strings; 20,000-character hostile input in under 200 ms |
| 8 | Matching: the screen reads the same cleaned string that is displayed, folded (NFKC, accents stripped, lowercase, straight apostrophes); Unicode-aware whole-word boundaries; `\b` forbidden; stems only at 5 or more letters; never bare substrings |
| 9 | Script rule: 3 or more letters (or over 10%) outside Latin hold as `unscreenable_language`; also, as a SHOULD, long text with under 15% very common English or Spanish words |
| 10 | Credential and ID patterns hold (`financial_id`): a separated SSN, a Luhn-valid card number, credential words. Phone numbers, e-mails, unit numbers, gate, lockbox and alarm codes do NOT hold (Peter accepted) |
| 11 | Feature-local list in its own file, version `wo-supp-v1` (now `wo-supp-v3`; v2 was a reviewed but never deployed step), code only. Adding terms is a Standard change; removing or loosening is Critical |
| 12 | Known-answer corpus: 150 or more must-hold and 100 or more must-pass strings, English and Spanish, with and without accents, including the ruling's anchor strings |
| 13 | A hit in the title or the description withholds both. Pod-unassigned never reads, screens or fetches. The screen runs only in shadow and on |
| 14 | Fixed held wording and a different fixed unassigned wording; no category line, no priority line; held output byte-identical across texts and causes |
| 15 | Shown block keeps Title (100), Category, Priority and Description (300), plus the fixed last line and the short cut pointer. Report the real worst-case length; do not trim the note to hit 600 |
| 16 | Field allowlist: only `name`, `description`, `is_emergency`, `is_urgent` are ever read (plus, once, the id of the Latchel answer, to confirm it is the job asked for) |
| 17 | Modes: `off` unchanged (golden); `shadow` identical to `off`; `on` includes the block; any other value means `off` |
| 18 | ON interlock: `on` takes effect only with `WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED` exactly `yes`; otherwise it behaves as `shadow`, logs one constant line, and the audit row records `on_downgraded` |
| 19 | In-flight guard expires after 5 minutes, carries a token, prunes on each call |
| 20 | Counts-only audit row with a fixed key set; no text, term, length, hash or per-term count; the existing alert-row columns stay FALSE/NULL. **Amended in Section 16.4: no category names either (R3-1)** |
| 21 | Nothing stored or logged: canary tests force a failure in every stage |
| 22 | No influence from the text (Rule 9): property test over 30 or more texts; source-level assertion |
| 23 | Keep the safety nets: plain text only, subject never contains new text, a block line with CR or LF is refused, a failure building the block never stops the alert |
| 24 | Ingestion exclusion: prepare only, on a separate branch, do not wire in |
| 25 to 27 | Spec, data inventory and `.env.example` updated for the no-AI design |
| 28, 29 | This document and the decision record |
| 30, 31 | Sample emails for Peter's sign-off; counts-only review queries |
| 32 | Sentinel and Viper before merge |
| 33 | Honest PR table |
| 34 | Process: worktree only; no push, merge, deploy, migration, live write or real email |

### 5.3 Categories the local list covers (as summarised in the build brief)

The shared Fair Housing categories, plus: safety and violence; minors; health; immigration and language; religion and identity (including slurs); benefits and income; **legal and eviction**; **arrest and criminal record**; **death**; financial identifiers; and unscreenable language. The three bold categories answer Mason's first content question: yes, text about eviction or legal proceedings, arrest or criminal record, and the death of a tenant is withheld. English and Spanish; accent folding is mandatory (many tenants type without accents). Deliberately NOT held, accepted as residual risk under Peter's answer 2: adult family-role words (mom, dad, wife, husband), numeric ages, euphemisms and indirect references, personal names, other Latin-script languages if the heuristic misses them, misspellings beyond accent folding, and anything not on the lists.

### 5.4 Shadow mode (as summarised in the build brief)

Shadow runs the same cleaner, local screen and read-only Latchel fallback that ON would run, on every qualifying alert, builds the block in memory, writes one counts-only audit row, and throws the block away. The email that goes out is byte-identical to OFF (tested), with one deliberate difference: while the block is active the same-job guard skips a duplicate concurrent delivery, so one email goes out instead of two. Nothing is sent anywhere. Pod-unassigned alerts are recorded as held with cause `pod_unassigned` without reading any text. (Since the second fix round, an alert with no inbox to send to builds no block, makes no lookup and writes no row.)

### 5.5 Thresholds and exit criteria (as summarised in the build brief; all required before Asimov is asked to confirm ON)

> **Amended by Section 17.4 (2026-10-16): OWNER OVERRIDE.** Peter declined the 7-day shadow week and the faster real-work-order check. Criteria (a) to (f) below were **not met and were never measured**; they are kept as the statement of what is unverified, and must never be described as met. Criterion (g) (the exclusion seen working, the decision record confirmed, the sample emails signed off) and (h) are **not** overridden. The audit rows are written in `on` as well as `shadow`, so the same counts can be read from the first live alert.

- (a) At least 7 consecutive days AND at least 40 screened attempts (shown, held by the local screen, or none; excluding `pod_unassigned` and `unavailable`). Otherwise extend in 7-day steps.
- (b) Zero scanner errors: `check_error`, `summary_error` and any self-test failure must be 0. One occurrence is a defect: fix it and restart the 7 days. (Amended by R3-4: text that does not settle in the cleaner gets its own cause and its own line, and does not count here, because a tenant could otherwise restart the week with about thirty characters.)
- (c) `unavailable` (Latchel lookup failed) at or below 5% of attempts.
- (d) Informational: if holds by the local screen exceed 30% of screened attempts, review with Peter. This is a usefulness question, not a safety stop. Report the `common_word_only` share; if it is more than half of all holds, Peter can ask for a deterministic phrase rescue as a separate Rule 6 loosening with its own 7-day re-run (not part of this build).
- (e) Zero holds across 40 or more screened attempts is a wiring failure until proven otherwise (prove the live path with the self-test and a synthetic canary run).
- (f) **Human second look** (replaces the AI second look Peter declined): 20 random jobs whose result was `shown` (or all, if fewer), opened in Latchel by Peter or a pod lead he names, who reads each title and description as the email would have shown it. Zero should have been held. Any miss means: add terms (Standard change), bump the version, restart the 7 days. Only counts are recorded (looked at, missed, how many non-English), never the text. A sample estimates the miss rate; one miss in 20 would be decisive.
- (g) The ingestion exclusion is live and verified (Section 8); Peter has confirmed the decision record and the Mason checklist a second time; he has signed off the synthetic sample emails.
- (h) Then Jarvis calls Asimov for the ON confirmation with the counts, the spot-check result and the verification. After ON the same counts go to Peter weekly for the first 30 days.
- **All counts must come from the final screen version.** Rows written under an earlier `screen_version` do not count toward (a) to (f). A version bump restarts the 7 days. From the day the clock starts, any change to a term, a screening rule or the cleaner's behaviour bumps the version; a change that does not is a defect.
- **Tripwire after ON:** any report of a title or description in an alert that should have been held sets the mode back to `off` the same day, the list is extended, and the 7-day shadow restarts.
- **Change control after ON (Rule 6):** adding terms is a Standard change (Peter's OK, version bump). Removing or loosening any term, adding an allow-phrase or rescue, changing limits above 100/300, or changing recipients is Critical (Peter's explicit OK, Asimov's re-review, a fresh 7-day shadow).

### 5.6 What replaces Mason (as summarised in the build brief)

Peter's override of Mason is valid under CLAUDE.md rule 3 (explicit, in the moment, after Jarvis surfaced what Mason would check; see the caveat in Section 4 about the relayed question). It removes Mason's sign-off. It does not remove the need for evidence that the safeguard works. Before Asimov will confirm ON, all ten of these are required. *(Amended by Section 17.4: items 4 and 5, the shadow week and the 20-job second look, are OVERRIDDEN by the owner and are not met; the others stand.)*

1. The written decision record, with Peter's four questions and reply verbatim, and Peter reading it and saying "confirmed" in chat (Jarvis writes the date).
2. The Mason checklist shown to Peter again at the moment of switching ON, with a fresh yes or no.
3. Mason's content questions answered by the list instead (eviction/legal, arrest/criminal record, death all held; Spanish keywords and accent folding mandatory; the unreadable-script rule). Mason's other two items are legal questions Asimov may not answer; they stay open, recorded as "accepted by owner, not reviewed by counsel" (Section 10).
4. The shadow week and its exit criteria.
5. The 20-job human second look with zero misses.
6. The "no AI" proof tests in the PR.
7. The ingestion exclusion live and verified.
8. Asimov's own activation confirmation on the counts, spot-check and verification.
9. Honest paperwork: the PR's Legal row says "OVERRIDDEN BY OWNER, not reviewed" with a link, never a green check or N/A; GOVERNANCE.md Rule 6 normally expects attorney review for a change to compliance logic, and the owner has overridden that here (Section 11).
10. A stop rule: see the tripwire above.

## 6. What cannot be overridden

Unchanged by Peter's answers, and unchanged by these final reviews:

- **Rule 9, the no-decisions firewall.** The text, the hold result and the category only decide what is displayed. They never influence recipients, routing, the subject, tasks, the alert row, priority or anything about a tenant or unit. (Fair Housing Standard rule 7 and Tier 3: no automated housing decision, and this feature makes none.)
- **Internal recipients only.** Pod shared inboxes, never a tenant, owner or vendor.
- **Fail closed.** Any error holds the block; the alert still sends.
- **No AI.** Peter's own decision, enforced by tests.
- **Nothing stored in Hub tables or logs.** The audit row is counts only; the existing alert-row columns stay FALSE/NULL.
- **Peter's own rule:** no SSNs, bank account numbers, passwords or protected-class data stored in any table (CLAUDE.md). The screen holds text that looks like an SSN, and since Section 16.4 the audit row carries no protected-class category names.
- **Peter's separate yes** for merge, deploy and going live (CLAUDE.md).
- **No Fair Housing language is generated.** The block quotes; it never writes. The category line is a fixed-label guess from a keyword table and is labelled as a guess.

## 7. Conditions for switching ON (checklist)

*Amended by Section 17.4 and 17.5: the items marked OVERRIDDEN were declined by the owner on 2026-10-16 (as relayed). They are not met and must not be ticked as met. Section 17.5 (b) is the working list.*

- [ ] Round 3 (R3-1 to R3-10, Section 16.5) complete and re-tested on the final screen version, **plus the round-4 fixes of Section 17.3**
- [ ] ~~7 or more consecutive days of `shadow` on that version, with 40 or more screened attempts (Section 5.5 a)~~ **OVERRIDDEN by the owner, not met**
- [ ] ~~Zero scanner errors and zero self-test failures; unsettled-text holds reported on their own line (b)~~ **OVERRIDDEN as a measurement, not met** (the start-up self-test and the tests still run)
- [ ] ~~`unavailable` at or below 5% (c)~~ **OVERRIDDEN, not measured**
- [ ] ~~Hold rate and `common_word_only` share reviewed with Peter (d)~~ **OVERRIDDEN as a gate**; recommended after the fact at day 3 and day 7 of live use
- [ ] ~~Live path proven by the self-test and a synthetic canary run (e)~~ **OVERRIDDEN in that form**; whether Latchel sends a description on new work orders is unconfirmed until the first live alert
- [ ] ~~20-job human second look, zero misses (f)~~ **OVERRIDDEN, not done; there is no measured miss rate**
- [ ] Ingestion exclusion deployed and **verified with a real alert** (Section 8; Peter said yes on 2026-10-16, deployed per Jarvis, evidence outstanding), and its code still present on the server after the last deploy of this feature
- [ ] Peter has read and confirmed the decision record (date filled in by Jarvis), and has seen the Mason checklist a second time with a fresh yes or no
- [ ] The as-built option (word list only, no AI, ordinary words hold) has been put to Peter in plain words **with the plain statement that no hold rate or miss rate was measured**, and he has said yes to it (Section 4, first note)
- [ ] Peter has re-confirmed that a miss is acceptable, **told that the rate is unmeasured and shown the testers' figures** (Section 17.1; decision record, "Facts" item 7)
- [ ] Peter has been told the real worst-case block length (733 characters, against "about 600") and accepted it or changed the limit (Section 16.1)
- [ ] Peter has signed off the synthetic sample emails (`approval-briefing/test/render-samples.js`), re-rendered on the final commit, **and the word-list diff**
- [ ] Sentinel has closed S2-A and S2-D and has no open S1 or S2 finding (S2-B closes with the real-alert evidence); Viper has no open real gap in the classes of Section 17.3; TARS passes on the final commit; Judge has signed off the delta; Ralph has re-run the changed pieces
- [ ] Asimov's activation confirmation
- [ ] Peter's separate, explicit yes to switch on

## 8. The ingestion condition (as summarised in the build brief)

**Facts.** `storeMessage` in `email-intake/lib/shared.js` is the single place that writes every message from the two pod inboxes into `missive_message_intake` (sender, subject, `body_html`, `body_text`); the 30-minute sync and the historical backfill both use it. No sender-based exclusion exists anywhere in the intake or archive code. The archive-search significance and severity passes are built to send stored message text to Anthropic. Jarvis reported (read-only, 2026-10-16) that 153 of the 160 alerts sent so far were already copied into `missive_message_intake` with status `processed`, and that `archive_search_corpus` holds searchable body text for copies. The table's status field allows only `pending` or `processed`, so a new "excluded" status or a stub row needs a schema change, and the table's retention rules restrict deleting rows. Sentinel confirmed in the first security review (of `0092ffe`) that the significance pass takes every row marked clear with no sender filter.

**Ruling.**
1. `off` and `shadow` do not depend on this: the email text is unchanged in both.
2. **`on` is BLOCKED until the exclusion is deployed and verified.** Peter's written acceptance (answer 2) covers a copy in the pod inboxes, Missive and the sent folder. It does not cover a copy in Hub tables searchable by every Archive Search user, nor the Anthropic-powered archive passes, which would directly contradict his answer 1. If Peter answers no to the exclusion, he must say so explicitly after being told those three consequences, and Asimov would have to re-rule; approval of `on` on that basis is not expected. Text in an alert that tries to instruct a downstream AI is closed by this exclusion and by nothing else.
3. The 153 alerts already copied contain no job description (they predate the block), so they are not a condition. They are left alone; any deletion is Peter's separate, explicit decision.
4. Sequence: (1) Peter says yes or no to the exclusion; (2) deploy the exclusion alone; (3) wait for at least one real natural alert and confirm it was skipped; (4) set `WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED=yes` only after that; (5) only then, with Peter's separate yes, switch to `on`.

**The prepared change (not built into this feature's commits).** A pure function `isWorkOrderAlertMessage(message)` called at the top of `storeMessage`, so the sync and the backfill are both covered; it returns null for a skipped message and both callers count it as "excluded". Both must hold: the sender equals (trimmed, case-insensitive) the Hub notification sender `noreply@rinconmanagement.com`, and the subject, after stripping leading Re:/Fw:/Fwd:, begins with "Work Order Alert". A reply guard also skips an internal `@rinconmanagement.com` sender whose normalised subject begins with "Work Order Alert" (a staff reply can quote the alert). Outside senders with that subject are stored normally (never subject-only: an outsider could copy the subject and hide a message from complaint tracking). One counts-only audit event per skip (`email_intake.work_order_alert_excluded`: message id, conversation id, mailbox key, reason code `sender_and_subject` or `internal_reply`; never subject, addresses or body). It lives on the branch `feature/email-intake-exclude-work-order-alerts` (commit `3f6922e`), with its tests and a short spec note. It narrows collection (no new mailbox or field), is a Standard change, and needs Peter's explicit yes before deploy. Asimov pre-approved this design if built exactly as described. **It is not part of any deploy of the description branch** and is not an ancestor of it (checked again for this review).

**Two honest costs for Peter's decision:** (1) staff replies inside an alert thread are also not archived (the reply guard), so they will not appear in Archive Search or complaint tracking; (2) the check trusts the From header Missive reports, so it depends on mail authentication on the company domain. Neither changes the recommendation to say yes.

**Update, 2026-10-16 (third-round review; see Section 17.2).** Peter said yes ("yes stop copying them"), and Jarvis reports the exclusion deployed and live on the server since about 15:10 local on 2026-10-16, from its own branch. Two things follow. (1) **The evidence is still missing:** no real alert had arrived afterwards. (2) **The exclusion is not an ancestor of the description branch.** A whole-Hub deploy or a merge of the description branch alone could put the old intake code back on the server (the deploy script does not delete unless told to, but it does overwrite files that differ), and the interlock would still say `yes`. So: the description deploy is file-scoped (the five runtime files and the comment in `router.js`), Scotty confirms by hash that the intake files on the server are unchanged before and after, and the exclusion branch is merged to the mainline before or together with the description branch so that git and the server agree. The sequence in item 4 above is unchanged; step (3) has to be satisfied on the final deployed state.

**The ON interlock is a switch, not proof.** `WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED=yes` is only an environment value; the code cannot tell whether the exclusion really exists. That is why Asimov's activation confirmation will require evidence: the audit event `email_intake.work_order_alert_excluded` for a real alert, and a check that the alert was not stored. Recommended hardening (not required): make the interlock also check that the intake module exports the exclusion function.

## 9. Residual risks, in plain words

These are the risks Peter accepted in answer 2 or that are named here as accepted. Each is a **class**; no example strings are written on purpose.

1. **A miss is possible and cannot be fully measured.** A word list cannot understand a sentence. Someone can describe a sensitive situation without any listed word, and the text will be shown. The human second look in the shadow week estimates how often; it does not remove the risk. In my own quick probe of about 75 natural English sentences the list held about nine in ten, and of about 50 natural Spanish sentences about three in four (before round 3; Section 16.1). Those are small, ad hoc sets, not a measured rate.
2. **Names, phone numbers, e-mail addresses, unit numbers, gate and lockbox codes are not screened.** If a vendor or tenant types a gate code into the description, it goes into the email. Peter accepted this. The email's last line says so.
3. **The email is a copy this system cannot control.** It lives in the two pod shared inboxes, in Missive, and in the noreply sent folder. Deleting it later means searching those places by hand (and Latchel stays the source of truth).
4. **Ordinary words hold, and so do some ordinary names and terms.** A job that says "paint the walls white" will not show its description. Red-team testing found that common first names that are also listed words, street names such as Church, Temple and Hospital, some trade jargon and abbreviation-heavy lines, electrical parts written with the micro or ohm sign, names with stroke letters, and long runs of digits (about one in ten of 13 to 19-digit runs happen to pass the card check) will hold an alert. The word list is not a dictionary of sensitive words: about 0.6% of dictionary words hold on their own. This is the cost of having no AI to tell the difference. The shadow week measures the real rate; Peter decides whether the feature is still useful at that rate.
5. **Other Latin-script languages** (Tagalog, Vietnamese, Portuguese and the like) are caught only by the "mostly unfamiliar words" heuristic, which is not applied to text under eight words and can miss text that happens to use many common English or Spanish words. Scripts such as Chinese, Korean, Arabic, Hebrew, Cyrillic and Thai are held outright, except that a whole word of at most two look-alike letters inside long English text is not caught.
6. **Deliberate evasion is only partly covered.** The screen reads the text with invisible characters and markup removed and with them turned into spaces, folds separators and holds look-alike letters. **Accepted classes, not covered:** letters of a word split by punctuation or spaces; words typed together with no separator (except the short list in R3-2); invisible characters placed both inside and between words (closed only for the same short list); digit or symbol substitution; elongated letters and ordinary misspellings; look-alike letters making a whole one-or-two-letter word; euphemism and indirect reference beyond the short lists; emoji other than the short list; a word split across the title and the description; encodings such as reversed text; and a tenant who forges the look of a status line inside the quotation marks. *(Round 4, R4-1: a punctuation, symbol or space character that Unicode rewrites as letters, typed where a space belongs, is now read as a space, so the exhaustive sweep of every punctuation, symbol and space code point of every plane, in every shared phrase, finds 0 slips. What that does NOT cover, by design and named here so the claim is exact: a circled, parenthesised or squared single letter, a digit-like mark (superscript, fraction, circled digit) and a Roman numeral standing between two words still glue a letter or digit to them, because they are letters and digits and the other readings must keep catching words spelled with them; and a phrase that needs both a zero-width character and a symbol as separators is covered only by the fourth reading and only up to the lists the readings share.)*
7. **The long tail of vocabulary.** Beyond the classes added in `wo-supp-v2` and in round 3 (R3-6), health conditions, equipment, nationalities and country names, immigration phrasing, religion and family words, legal and criminal phrasing and death phrasing are covered only by what is on the lists. The shadow week's second look was to be how gaps are found from here; **Peter declined the week (Section 17.4), so after the bounded fixes in Section 17.3 gaps are found only by use**: the tripwire (a report sets the mode back to `off` the same day) and the optional first-day read of the live blocks. No further red-team vocabulary rounds are required, but nobody should read the absence of a measurement as a low miss rate (Section 17.1 gives the only figures that exist).
8. **Links.** A bare web address on an uncommon ending, a plain-label address on one of the everyday two-letter endings (in, to, so, it, id and the like), a defanged address, and a plain e-mail address (left alone by design) are shown as typed. The email is plain text for internal staff; a mail program may still turn them into clickable links. Sentinel's S2-A is a gate for ON (Section 16.3). *(Round 4, recorded here as the review asked: **the measurement exemption.** A web-address-like word made only of a number of one to four digits and ending in one of mm, cm, km, kg, lb, ml, mg, ma, mv, mw or kw is shown as typed, so that "6.ml of sealant" is not mangled. Five of those endings (ml, ma, mw, mv, kw) are also real country domains, so a number-only name on one of them is a legal web address that is shown as typed (Sentinel S3-N2, TARS); an address with a letter label, a path, a port or a query on those endings is still replaced. Round 4 also closed two link shapes: a web-like word in front of an at-sign is left alone only when what follows the at-sign is itself a host with a dot and a listed ending, and a host followed by a number-like or accented character right after its ending is replaced.)*
9. **Numbers.** Social Security, card or account numbers written with unusual separators, bare nine-digit runs, bank account and routing numbers, PINs and passwords written without the listed credential words pass. Gate and lockbox codes pass by Peter's decision. *(Recorded here only, from Sentinel S3-4 and Viper B9, round 3: no code change. A Social Security number written with dots or slashes, a driver's licence number or a date of birth written without the listed words, and a card number written with dots or commas are examples of the class. The Social Security pattern runs only on the hyphen-kept copy; running it on the word copy as well would close the first example cheaply and is left for a later, separate change.)*
10. **Category names in the audit log** were a sensitive inference about a household. They are withdrawn from the audit row by R3-1 (Sections 14 and 16.4).
11. **Retention and lawfulness of the pod-inbox and Missive copies are unreviewed by counsel** (Section 10).
12. **Removing joiner characters splits emoji sequences** (a family emoji becomes separate emoji). Cosmetic; accepted.
13. **A rare double email remains possible** if the Hub is killed after the email is sent but before the alert row is written (pre-existing behavior, unchanged). The same-job guard removes the common double (created plus updated deliveries) in shadow and on.
14. **Display fidelity.** The text is normalised before it is shown. Fractions, powers, degrees and similar marks are now kept exactly as typed. Text inside angle brackets is read as markup and removed without a trace, although the last line says "Quoted as typed", and an unusual web-like word may become "[link removed]". The email always says the full text is in Latchel. *(Round 4: a word that begins with a listed domain ending and continues with an accented letter, typed with no space after a full stop in Spanish text, is read as the end of a web address and replaced by "[link removed]" followed by the rest of the word; the cost is a less readable sentence, never a hold.)*
15. **A pre-existing weakness, not new:** a job id that is an unusual object (not text or a number) could throw an error that escapes the alert handler in every mode. It needs the webhook secret to reach.

## 10. Mason's open items: ACCEPTED BY OWNER, NOT REVIEWED BY COUNSEL

Peter skipped Mason's review (answer 3). What Mason would have checked, as Jarvis surfaced it to Peter:

| Mason's question | Status |
|---|---|
| Should text about eviction or legal proceedings also be withheld? | Answered by the list: yes, held (`legal_eviction`), including "N day notice" in all its common forms once R3-5 is in |
| Should text about a criminal record or arrest also be withheld? | Answered by the list: yes, held (`criminal_arrest`) |
| Should text about the death of a tenant also be withheld? | Answered by the list: yes, held (`death`) |
| Is an English-only keyword layer acceptable for Spanish text? | Answered by the list: Spanish keywords and accent folding are mandatory, and the unreadable-script rule covers scripts the lists cannot read. **At `ce30374` Spanish coverage is thinner than English; R3-6 closes the gap for the vocabulary already held in English.** Whether the result is legally *sufficient* was not reviewed by counsel |
| Is it lawful to keep tenant-written text in the pod inboxes and Missive? | **ACCEPTED BY OWNER, NOT REVIEWED BY COUNSEL.** Asimov may not answer legal questions. Peter can send it to Mason at any time; it does not block building |
| Retention for those copies | **ACCEPTED BY OWNER, NOT REVIEWED BY COUNSEL.** No retention figure is set by this system or by this document |

**One thing I cannot verify.** The material given to me says Jarvis surfaced this checklist to Peter but does not show whether he saw it before or after he said "skip this review", and the question as relayed (Section 4) does not contain it. The checklist must be shown to him again, with a fresh yes or no, at the moment of switching ON (Section 7), and I recommend showing it when he is asked for the shadow yes. Until then the override stands for building, deploying OFF and running the shadow week; it is not a standing waiver for ON.

## 11. Rule 6 and Rule 7 notes

**Rule 6 (attorney review and shadow mode).** GOVERNANCE.md Rule 6 classes a change to compliance logic as Critical: owner approval, **attorney review for compliance changes**, and 7 days of shadow mode. This feature is a new compliance control (a screen that decides what protected-class-adjacent text may be emailed), and attorney review would normally be expected. **The owner has overridden attorney review here (answer 3), and on 2026-10-16, later the same day, he also declined the 7 days of shadow mode** (as relayed; quoted in Section 17.4; this paragraph earlier said the 7 days were not overridden, which is no longer true). This document records the overrides; it does not cure them. If a complaint, audit or counsel ever asks whether this was reviewed by an attorney, the honest answer is no.

**Rule 7 (agent lifecycle).** Rule 7 gives 30 days of shadow for low-risk agents and 90 for user-affecting ones, before an agent goes active. **That longer shadow was not applied.** This is not a new agent: it is an optional display block added to an alert that is already live and that decides nothing about any person (Rule 9). Asimov therefore ruled 7 days (the Rule 6 figure) with the exit criteria in Section 5.5; **those 7 days were then declined by the owner (Section 17.4)**. This is recorded so nobody later believes the 30- or 90-day figure, or the 7-day figure, was met. If Peter or counsel wants a longer shadow, longer is allowed and costs nothing but time.

**Change control for the fix rounds.** Adding words to the list is a Standard change (Peter's OK, version bump to `wo-supp-v2`; nothing is removed). Making the screen read more copies of the text, or hold more kinds of text, only tightens it and is not a loosening. Narrowing the web-address rules so that ordinary sentences are not mangled is a loosening of a link rule, not of the protected-class screen; it is a Standard change that needs Sentinel's re-check, and Sentinel found that the way it was done in `ce30374` went further than described (S2-A, Section 16.3). Removing category names from the audit row is a reduction of what is stored and is not a loosening of the screen.

## 12. Findings from the first review round, and where they stand after the final review

| Finding | Closed by | Status after the final review |
|---|---|---|
| (a) Cleaner must remove variation selectors, Hangul filler and other invisible characters | Removal of default-ignorable, control, format, private-use and surrogate characters, plus U+2800 and U+FFFC; full Unicode sweep test | Closed. Side effect found: removal glues words where an invisible character or tag stood in place of a space. Fixed by condition W4 (verified, Section 16.2) |
| (b) Bare web addresses, shorteners, mailto, javascript and data links neutralised without mangling e-mail addresses or phone numbers | Link rules and preserved-cases tests | Closed for the cases specified. The two defects found (a cut leaving a web-like tail, ordinary sentences mangled) are fixed; the way the second was fixed re-opened some endings (Sentinel S2-A, R3-3) |
| (c) In-flight guard needs an expiry | 5-minute expiry, token, pruning; monotonic clock since the second fix round | Closed and independently tested, including with the system clock stepped back |
| (d) Spec Section 3 must say free text is read in shadow and on, and scanned locally only | Spec Sections 3 and 6A | Closed |
| (e) "Held for privacy review" misleading for the unassigned pod | Separate fixed sentence; the phrase is retired everywhere | Closed (I checked the rendered samples again) |
| (f) Tests did not catch a log of job text in the summary-error path, or job text influencing recipients (mutants M03, M30, M24) | Canary tests for every stage, property test and source assertion, mutation check | Closed. Several separate reviewers ran their own leak and influence sweeps with no leak |
| (g) This document was referenced in code comments but did not exist | This document, plus a test that every referenced compliance file exists | Closed |
| (h) Removing U+200C and U+200D splits emoji sequences | Noted in code, spec and Section 9; accepted | Closed |
| (i) The contextual classifier logs an error message verbatim | That path is not called at all; the import graph proves it is not even loaded | Closed (I re-ran the import check again) |

## 13. PR checklist rows (GOVERNANCE.md Integrity Rules 1 and 3)

Status as it must be written in the PR body on the day of submission. **A mark is valid only for the commit it was earned on. Round 3 changed code and round 4 will change it again, so every row below resets to pending for the final commit until its specialist re-runs.** Today these rows are not all green and must not be shown as green. **The table below is the state at `ce30374`; the state at `2ab3d53` and what each row must read on the final commit is in Section 17.6.**

| Gate | Specialist | Status | Notes |
|---|---|---|---|
| Branch | Jarvis | feature branch | `feature/work-order-alert-description` |
| Schema | Neo | N/A | No schema change, no migration |
| Backend | Q | done, round 3 open | Conditions R3-1 to R3-8 |
| Tests | TARS | **PASS on `ce30374` only** | 160 of 160, off-mode identical to the live parent in 576 comparisons. Re-run required on the final commit; green only then |
| Chaos | Ralph | resilient on `0092ffe` | Re-run on the changed pieces (no-inbox path, guard clock, unsettled-text cause) after round 3; pre-existing items listed in Section 16.3 |
| Red Team | Viper | **BYPASSES FOUND until re-tested** | Round 2 found nothing critical; the real gaps are the "fix before the clock" classes in Section 16.3. Not a green mark until the replay passes |
| Security | Sentinel | **OPEN S2 findings** | S1: 0, S2: 3 (S2-A link rule, S2-B Missive exclusion and interlock, S2-C audit rows). Green only when all three are closed or decided |
| Governance | Asimov | **Approved with conditions (deploy OFF); shadow not approved on `ce30374`; ON blocked** | Link to this document |
| Legal | Mason | **OVERRIDDEN BY OWNER, not reviewed** | Link to `work-order-note-alerts-description-decision-resolution.md`. Not a green check. Not N/A |
| Quality | Judge | pending | Rejected `0092ffe`; re-review of the delta is required and never deferred (Integrity Rule 3) |
| CI | TARS and Jarvis | pending | |

Integrity Rule 1 (no false green check) applies to the Legal row: it must read "OVERRIDDEN BY OWNER, not reviewed", with the link, in the submitted PR body. Integrity Rule 2 (no pending rows in a submitted PR) means the PR is not submitted until the open rows above are resolved.

## 14. Category names are not stored in the audit log (amended 2026-10-16, second final review)

The first version of this section said that category names in the audit row (for example `safety_violence`, `minors`, `health`) are a sensitive inference about a household and should be handled like `maintenance_claims.flagged_category`. I allowed the names in my earlier rulings. That was wrong against Peter's own standing rule, which is stricter than my ruling: **"Never store ... protected-class data in any table"** (CLAUDE.md). The vocabulary includes names such as race and colour, disability and health, religion and national origin; a row that says a named job at a named property was held for one of them records an inference about the people there, and the audit log keeps it indefinitely. Peter was not asked about it in his four questions. Sentinel raised this as S2-C; I agree.

**Ruling.** The `work_order_note_alert.description_checked` row carries no category names (R3-1). It keeps the job id, trigger source, mode, result, cause, the yes/no for "only ordinary words matched", the version, and the flags. The shadow week's exit criteria do not need the names. If Peter, told this in plain words, decides he does want them for tuning, that is his explicit call and the old handling rules would apply (access limited to those who may already read the audit log, never pasted beside a job id in tickets or chat); I do not recommend it. Until R3-1 is in, shadow is not to be switched on.

---

## 15. First final review, 2026-10-16 (build commit `0092ffe`, after TARS, Sentinel, Viper and Ralph)

*This section is the record of the first final review. Where it differs from Section 16, Section 16 governs.*

### 15.1 What I checked myself

- Read the whole change from the live base `058618d` to `0092ffe`: the summary builder, cleaner, screen, alert wiring, router comment, `.env.example`, spec, data-inventory addendum, and the rendered sample emails.
- Ran the full test suite in a scrubbed environment: **124 of 124 pass** (81 alert tests, 15 cleaner, 20 screen-corpus, 8 no-AI proofs). The screen-corpus held 232 must-hold and 131 must-pass strings.
- Loaded the alert module in a fresh process: **9 project modules, none of the forbidden ones** (no model SDK, no claim check, no Tier B classifier, no notes check or classifier). A search of the four feature files for the forbidden identifiers found nothing. The AI check module is deleted and nothing references it.
- Rendered all 8 sample emails. The held and unassigned blocks contain no byte derived from the job text.
- Reproduced, with my own probes, the defect classes that Viper, TARS and Sentinel reported (Section 15.3).
- Measured the worst-case block length at the time as 710 characters, and about 727 with the two longest category labels. **The exact figure, computed from the constants, is 733 (Section 16.1).**
- Reviewed the prepared ingestion exclusion commit `3f6922e`: it matches my ruling and is on its own branch.

Three independent reviewers ran separate leak sweeps with a unique marker in the job text across dozens of failure paths. The marker never reached a log, a database write, the failure email to Peter or the subject; it appeared only in the body of `on`-mode emails, which is the intended place.

### 15.2 Requirement-by-requirement status (at `0092ffe`)

Met and independently supported: **1, 2, 3, 4, 13, 14, 16, 17, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30, 31, 34.** The others needed action: 5 (W4), 6 (W1, W3), 8 (W5), 9 (W8), 10 (W7), 11 (W6), 15 (the number), 25 (W9), 32 (reviews open), 33 (pending). Section 16.2 gives their status at `ce30374`.

### 15.3 How I weighed the findings (first round)

"Before the clock" means before the 7-day shadow week starts, because a change to the screen or cleaner after that point makes the shadow counts about a different version (Section 5.5) and restarts the week. Shadow never shows anything to anyone, so its risk is the local processing, the Latchel lookup, the audit rows and the guard, not display.

| # | Finding | From | Outcome at `ce30374` |
|---|---|---|---|
| F1 | A job id that is not plain digits could reach the Latchel web address | Sentinel | Closed (W2, verified) |
| F2 | The cut at 300 characters happens after checking, so the shown tail could be an unchecked fragment | Sentinel | Closed (W3, verified) |
| F3 | Display accuracy: a stacked fraction misquoted; ordinary sentences with a missing space after a full stop turned into "[link removed]" | TARS | Closed for display; the fix for the second part went wider than described (S2-A, R3-3) |
| F4 | Words glued together where an invisible character or tag stood for a space | Viper | Closed for one kind of removal at a time (W4); mixed removal is R3-2 |
| F5 | A shared phrase written with a hyphen or other separator slips past | Viper | Closed for five separators (W5); other punctuation is R3-2 |
| F6 | Natural-language gaps (assistance animals, plurals, abbreviations, Spanish equivalents) | Viper | Partly closed (W6); R3-5 and R3-6 |
| F7 | Look-alike Latin letters; non-ASCII digits | Viper | Closed (W7, verified) |
| F8 | Language heuristic diluted by an English title or by text after the cut | Viper | Closed (W8, verified) |
| F9 | Emoji and symbols that carry meaning | Viper | Short list added; rest accepted; R3-6 completes the unambiguous ones |
| F10 | Deliberate letter-splitting; uncommon top-level domains; euphemism | Viper | Accepted residual (Section 9) |
| F11 | False-hold cost: first names that are listed words, street and building words, trade jargon | Viper | Measured by the shadow week, not tuned beforehand |
| F12 | The Missive copy of an alert would carry tenant-written text into Hub tables and the Anthropic-powered archive passes | Viper; Sentinel S2-2 | Hard block on ON (Section 8) |
| F13 | ON interlock is an environment value, not proof | Viper | Asimov's activation requires evidence (Section 8) |
| F14 | Chaos items: slow reconcile pass, cron call without a time limit, double email if killed mid-send, a screen returning a rejected promise | Ralph | Rejected-promise case fixed; cron time limit is Scotty's (S-2); the rest are pre-existing and non-blocking |
| F15 | Housekeeping: slur words in a comment and a test; wrong count in the spec status line; the worst-case length | TARS | Closed (W9, verified) |

**The block length.** Peter's "ok" on limits was about 300 and 100 (Section 4). The soft target "about 600" came from the build brief. The real worst case is above it and Peter has not yet been told; see Section 16.1 for the exact number.

### 15.4 What went right

- **No AI, three ways, plus mine.** Import graph, blocked network with a dummy key, source scan; and I re-ran the import graph and the identifier search myself in both reviews.
- **Off is the same as today.** TARS compared the new code with the true parent over 576 combinations and Ralph over 2,178 runs earlier, with no difference in the email, recipients, database writes or logs.
- **No job text stored or logged.** Several independent sweeps, in both rounds.
- **No influence from the text.** Hundreds of comparisons of recipients, subject, rows, tasks and the email outside the block.
- **Fail closed.** Scanner failure, bad input, hung lookup, audit failure and mail failure all send the alert without the block, or with the fixed sentence.
- **Nothing hangs.** The 10-second lookup limit and the 5-minute guard expiry both held under the chaos tests.

### 15.5 Verdicts at the first final review (superseded by Section 16.5)

(a) Deploy OFF: approved with conditions. (b) Shadow: approved with conditions W1 to W13, not on `0092ffe` as built. (c) ON: blocked. The deploy conditions were written in this section as D1 to D7 (fix round and TARS; Sentinel; Judge; Peter's yes; Scotty; exclusion not in the deploy; PR table and repository visibility) and recorded in the verdict as D1 to D4 (D1 fix round and TARS; D2 Sentinel; D3 Scotty; D4 PR table and exclusion not in the deploy), with Judge's sign-off and Peter's yes carried in the pipeline. The two numberings describe the same conditions. They are assessed in Section 16.2 using the verdict's numbering; W11 to W13 and the Judge and Peter items carry into Section 16.5.

### 15.6 For Peter (first round)

Items 1 to 10 of the first list carry into Section 16.6.

---

## 16. Final review of the second fix round, 2026-10-16 (commit `ce30374`)

Reviewed: commit `ce30374` on `feature/work-order-alert-description`, on top of `1b33886`. Inputs: the fix round, TARS (pass), Sentinel (findings), Viper (bypasses found, nothing critical), and my own probes. Judge's re-review of the delta is not yet done.

### 16.1 What I checked myself

- **Read** the change `1b33886..ce30374`: cleaner, screen, summary builder, alert wiring (no-inbox path, monotonic clock, mail-error reduction), the term list, tests, spec and data inventory.
- **Ran the whole suite** on an extracted copy of `ce30374`: **160 of 160** (81 alert, 15 cleaner, 20 screen-corpus, 8 no-AI, 36 fix-round) in a scrubbed environment. The known-answer corpus holds 311 must-hold and 167 must-pass strings.
- **No AI, again:** fresh-process load of the alert module: 9 project modules, none forbidden, no model SDK in the module cache; the four feature files contain no AI, network, file or child-process identifier; the only environment reads are the two `WORK_ORDER_ALERT_*` switches; the module loads and self-tests in about 46 ms.
- **The v2 word list, compared by program against the v1 list at `1b33886`:** 0 terms removed, 0 terms changed, **213 terms added** (the hand-off said 203; the test and my count say 213), 3 pair rules added, 0 slurs, 0 common words and 0 shared common terms changed, 10 symbol groups added, the 22-name category vocabulary unchanged. Two of the added terms are flagged as ordinary words. Only the version string and two renames differ from v1. **It is additions only, nothing loosened.** It is a Standard change that needs Peter's OK.
- **Slur literals:** none in any of the 24 changed files other than the terms file, and none in the commit messages. One literal remains in the **history** of `0092ffe` (a comment in the screen file). The terms file holds the slur list by design.
- **Block length, computed from the constants:** 100-character title, 300-character description, the two longest category labels, "Emergency / Urgent", the cut pointer and the 104-character last line: **733 characters over 6 lines at most**, as Q and TARS report. About 606 with no category label, a typical block about 330. This is over Peter's soft target of about 600. Nothing has been cut.
- **Repository visibility (read-only check today):** **PUBLIC.**
- **Probes of my own** through the real code path (a stub only, no mail, no network): the display of fractions, powers, degrees and a missing space after a full stop; real links; sixteen job-id shapes; the cut and the re-screen after it; the language rule on the title alone; the shared phrases with hyphen, slash, underscore; invisible and unassigned characters; look-alike letters; non-ASCII digits. All as specified, except the classes in 16.3.
- **Natural-sentence probes (small, ad hoc, mine, not a measured rate):** 74 English sentences about the usual protected topics: 67 held (91%). 51 Spanish sentences on the same topics: 39 held (76%). That gap is why R3-6 exists.
- **Off-mode identity:** I rely on the golden tests (pass), TARS's 576-comparison check against the live parent (identical) and Sentinel's reading; I did not repeat the comparison.

### 16.2 My conditions from the first final review, checked in code

The deploy conditions are numbered here as in the verdict record (D1 to D4, see Section 15.5); W1 to W13 are as in Section 15.

| Condition | Result | Notes |
|---|---|---|
| D1 fix round committed, TARS re-pass | **Met** | `ce30374`; TARS PASS 160 of 160, off identical to the live parent |
| D2 Sentinel confirms S2-1 closed (job id; shown strings re-checked after the cut) | **Met for the two defects I named.** The wider link finding is open | Sentinel verified both closed. Sentinel's separate S2-A (link rule re-opened by the display-fidelity fix) blocks ON, not deploy OFF |
| D3 Scotty: Node version, load on the server, env check | **Not yet done** | Needed before any deploy, even OFF, because the new patterns are compiled when the module loads |
| D4 PR table honest; Missive branch not in the deploy | **Pending** (Jarvis, Section 13) | The Missive branch `3f6922e` is not an ancestor |
| W1 display fidelity | **Met in behaviour; the link side went too wide** | Fractions, powers, degrees, trademark are kept as typed; sentence-break words are shown as typed. Sentinel and Viper show the exemption covers 99 everyday-word endings, not only a sentence start. Fix: R3-3 |
| W2 job id | **Met** | I tried 16 shapes: a call only for 1 to 12 plain ASCII digits; a different or missing id in the answer gives "could not be retrieved" |
| W3 re-check after the cut | **Met** | Link detector and screen run on the exact printed strings; Sentinel and Viper tried and failed to bypass it |
| W4 second reading (removed pieces become spaces) | **Met for one kind of removal; mixed removal accepted** | See 16.3 item B2 and R3-2 |
| W5 separator-folded copy for the shared phrases | **Met as I worded it; my wording was too narrow** | I named hyphens, dashes, underscores, slashes and periods. Other punctuation between the words of a shared phrase defeats it, including the Section 8 category. That gap is mine. Fix: R3-2 |
| W6 list additions, additions only, `wo-supp-v2` | **Partly met** | Additions only: verified. Assistance animals, plural identity words, abbreviations, symbols, a short domestic-violence list: in. "Any N day notice" is incomplete (R3-5). Spanish coverage lags English (R3-6). First-person violence wording is missing (R3-6) |
| W7 look-alikes and non-ASCII digits | **Met** | A whole look-alike word of one or two letters is the accepted residual |
| W8 language rule on the parts | **Met** | At a cost of one more hold in TARS's 128 ordinary work orders |
| W9 slur literals; SPEC status line; length; mutation check | **Met** | 98 of 98 mutants caught by Q's check and by TARS's re-run; TARS's own 77 mutants: 74 caught, 2 equivalent, 1 real test gap (R3-7) |
| W10 corpus of the new classes, zero new false holds | **Met** | 30 new must-hold and 22 new must-pass; 0 new false holds on the original 131 |
| W11 re-test | **Partly done** | TARS, Sentinel and Viper have run; Judge and my own diff check are done now; they must run again after round 3 |
| W12, W13 | **Open** | Peter's yes and the briefing; Scotty's cron time limit |

### 16.3 The remaining findings, and what I decided

"Fix before the shadow clock" means the item is cheap, shows up in natural (not deliberately evasive) typing or conflicts with something Peter was told, and the week must be counted on the fixed version. "Accepted residual" means Peter's answer 2 covers it or it is a named class that more rules would chase without end; it is written in Section 9 and the SPEC by class.

| # | Finding (class) | From | Decision |
|---|---|---|---|
| S2-A | Link rule loosened: the Title-case "word.Word" exemption covers many everyday-word endings and does not check that it is a sentence start; an at-sign with no name before it is treated as a plain e-mail address | Sentinel; Viper B3, B4 | **Fix before the clock (R3-3):** hold instead of guess. Sentinel decides what else counts. Blocks ON |
| S2-B | Missive-intake exclusion absent; interlock is a bare environment value | Sentinel | **Hard gate on ON** (Section 8). Carried unchanged; Peter has not decided |
| S2-C | Audit rows tie job id and property id to protected-category names, kept indefinitely; conflicts with Peter's standing rule; not put to him | Sentinel | **Fix before shadow (R3-1)**, or Peter's explicit informed yes (not recommended). Section 14 |
| B1 | A shared phrase (the Section 8 category and 26 others) typed with punctuation other than the five I named is not held | Viper (high) | **Fix before the clock (R3-2)** |
| B2 | Invisible characters or tags both inside and between words defeat the two readings | Viper | **Partly fixed by R3-2** (a squashed check for a short list). Otherwise accepted residual |
| B6 | Spanish words for classes the English list already covers are shown | Viper | **Fix before the clock (R3-6)**; this contradicts what Peter was told in the Mason checklist |
| B7 | Violence and stalking told in the first or second person ("my ...", "your ...") are shown; the list is third-person | Viper | **Fix before the clock (R3-6)**, direct statements only |
| B8 | "N day notice" incomplete: digits written against the word, qualifiers such as business or calendar, "days of notice", several number words, some Spanish forms | Viper | **Fix before the clock (R3-5)**; I wrote "any" |
| B11 | Plural and possessive forms of single-word slurs are not held | Viper | **Fix before the clock (R3-6)**, cheap |
| B12 | A tenant can force a scanner error on their own job with about thirty characters, which would break the "zero scanner errors" exit criterion and restart the week | Viper | **Fix before the clock (R3-4)** |
| TARS | One real gap in TARS's own mutants | TARS | **Close (R3-7)** |
| B5 | Plain-label hosts on the everyday two-letter endings are kept | Viper; Sentinel | **Accepted residual**, named. Hold-or-neutralise would mangle ordinary sentences; the email is plain text |
| B9 | Credential and number patterns with unusual separators, credential words beyond the list, PINs | Viper; Sentinel S3-4 | **Accepted residual** (Peter's answer 2 covers codes; Section 9 item 9) |
| B10 | A whole look-alike word of one or two letters | Viper | **Accepted residual** |
| B13 | Quoted text that imitates a status line or a forged closing quote | Viper; Sentinel S3-3 | **Accepted residual** for people. The route into the AI archive passes is closed only by the Missive exclusion |
| B14 | Text in angle brackets disappears while the last line says "Quoted as typed" | Viper | **Accepted residual**, documented (Section 9 item 14). Peter sees it in the sample emails |
| B15 | A job id that is an exotic object can throw past the handler | Viper | **Pre-existing**, needs the webhook secret; Q may fix it in passing, not required |
| B16 | Hostile input costs the Hub up to about 0.4 second of work each | Viper; Sentinel | **Accepted**; no runaway case found anywhere; a time guard backs it |
| Viper 3, 5, 6, 9 to 14 | Letter-splitting; run-together words beyond the short list; leetspeak; elongation and misspellings; long-tail vocabulary; Social Security and number patterns; word split across title and description; very short foreign text | Viper | **Accepted residual**, each named in Section 9. The long tail beyond R3-6 is found by the shadow week's second look, not by more red-team rounds |
| S3 | Sentinel's S3-1 to S3-6 (link residual classes, the ordinal-mark case, unescaped quote, number residuals, repository public, carry-overs) | Sentinel | **Low.** Q fixes the cheap ones in round 3 and records the rest; none blocks. S3-5 is a hard condition (the repository) |
| Ralph | Reconcile time budget and cron call without a time limit; duplicate-email window; null error in the off-mode catch; failure-notice try/catch; duplicate pod-missing tasks; event-loop cost | Ralph | **Pre-existing, non-blocking.** The cron time limit is Scotty's (S-2); the others are tracked, not part of this change |
| False holds | Word and number cases that hold ordinary text (micro and ohm signs, stroke-letter names, abbreviation-heavy lines, long digit runs, ordinary words) | Viper; TARS | **Not tuned before the week.** The shadow week measures the rate; Peter decides (Section 5.5 d) |

### 16.4 What I got wrong or changed my mind about

1. **Category names in the audit row.** I allowed them. Peter's own rule is stricter and he was not asked. Withdrawn (Section 14, R3-1).
2. **W5's separator list was too narrow.** It left the most important Fair Housing phrase open to ordinary punctuation. My wording, my gap (R3-2).
3. **"Any N day notice."** I wrote "any" and the build covers the common forms. Completed in R3-5.
4. **"Spanish keywords are mandatory."** That was the answer to Mason's fourth question as shown to Peter. At `ce30374` it is true of the structure, and not yet of the coverage. R3-6 makes it true for the vocabulary already held in English.
5. **Peter's answer 4 and "about 600".** The figure was not in the question. Corrected in Section 4.
6. **Question 1's two options.** The as-built option was not among them. Recorded in Section 4 and made a condition (W12 and Section 7).
7. **The "squashed word" check.** I called it optional. Words such as compound terms typed as one word are ordinary typing, not only evasion. A short, fixed list is now in R3-2 (Viper's prototype: all 13 test cases caught, no false hold on 101 ordinary texts).

### 16.5 Verdicts and conditions

**(a) Deploy with the mode OFF: APPROVED WITH CONDITIONS.**
Why: with the mode off or unset, nothing in the new code runs on a job, the email is byte-identical to today's (TARS, 576 comparisons; the golden tests), no AI is loaded, nothing leaves the server, and Sentinel found it clear for deployment with the mode off. The approval applies to `ce30374` or any later commit that keeps the mode-off email identical and passes the re-runs below. Jarvis should advise Peter to do round 3 first and deploy once, so that shadow does not need a second deploy and a second yes.
- **O-1.** Judge reviews the delta on the commit that will be deployed and signs off (Integrity Rule 3: never deferred).
- **O-2.** TARS (and Sentinel, if the commit is later than `ce30374`) re-run on that exact commit.
- **O-3.** Scotty confirms the production Node version supports the pattern features used (Unicode property escapes, lookbehind, `matchAll`; tested on Node 24 only; "unassigned" follows the server's Unicode tables), loads the alert module on the server with placeholder values and no network **before** restarting the live Hub (the patterns are compiled at load, even with the mode off), and confirms after deploy that `WORK_ORDER_ALERT_DESCRIPTION_MODE` is unset or `off` and `WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED` is unset or `no`. Rollback is the previous release. Only the five runtime files change (`work-order-notes-alert.js`, `work-order-summary.js`, `work-order-text-clean.js`, `work-order-text-screen.js`, `work-order-text-screen-terms.js`), plus a comment in `router.js`; Scotty checks the direction of any difference with the server copy before overwriting anything.
- **O-4.** The repository is made private **before any push** of this branch. It is public today. The compliance files, the screening source and the list of terms are in it, and one slur literal sits in the history of `0092ffe`.
- **O-5.** The Missive exclusion (`3f6922e`) is NOT part of this deploy. The PR table reads Legal = "OVERRIDDEN BY OWNER, not reviewed" with the link (never a green check, never N/A), and Tests, Red Team, Security and Quality are not green until re-run on the final commit.
- **O-6.** Peter says yes, separately, to merge and then to deploy (CLAUDE.md). His four answers were about the design and are not a yes to either.

**(b) Start the SHADOW week: NOT APPROVED on `ce30374` as built.**
What must change before it can be approved (Q builds; the reviewers re-run; none of this is a loosening):
- **R3-1 (S2-C).** The audit event carries no `held_categories` (Section 14). The category query in the review SQL is deleted. SPEC 6A, the data-inventory addendum and the tests follow.
- **R3-2 (B1, B2).** (i) The shared `scanText()` also runs on a copy in which every run of characters that is not a letter or digit is one space, so any punctuation between the words of a shared phrase is read as a space. (ii) A local rule for the Section 8 category: "section", "sec" or "seccion" followed within two words by 8, eight, viii or ocho. (iii) A squashed check: with every non-letter and non-digit removed, a short fixed list of about 30 long two-word protected phrases (each at least nine letters, taken from the shared and local lists) written as one word, or glued by invisible characters inside and between words, holds. No general substring matching.
- **R3-3 (S2-A, B3, B4).** The Title-case "word.Word" sentence-break shape no longer shows the text as typed: the block is HELD (cause `local_screen`, no category), because the same shape is also how a brand-looking address is written. An at-sign with no name before it is not a plain e-mail address. Anything else Sentinel names as a re-opened listed ending is treated the same way: hold or neutralise, never show. Nothing is shown mangled, so Judge's display point stays met.
- **R3-4 (B12).** Text that does not settle in the cleaner's passes is held with its own cause (Q names it, for example `unsettled_text`), medium risk, reported on its own line in the review counts, and not counted as a scanner error in exit criterion (b). Q may also allow more passes so that ordinary double-escaped text settles; the idempotence and no-link guarantees must still hold.
- **R3-5 (B8).** "N day notice" completed: digits or number words up to ninety-nine and hundred; the digits written against the word; business, calendar, court and working before "day"; "days of notice" and "notice of N days"; "(N) day"; Spanish "notificacion de N dias" and "aviso N dias" in digits or words. Entry notices in hours are not held unless followed by to quit, vacate, pay, perform or cure.
- **R3-6 (B6, B7, B11, symbols).** A bounded vocabulary round, **additions only, shown to Peter as a diff, a Standard change.** Classes: (a) Spanish for the vocabulary the English list already covers: disability and equipment, old age, widowhood and marital status, retirement and pensions, public benefits and food programs, immigration papers and residence, pregnancy and birth, police reports and complaints, fear and fleeing, hitting, children and grandparents including affectionate forms, assistance animals, and "from" plus a country; (b) direct first- and second-person statements of violence, stalking and fear, and the person's own "ex", in English and Spanish; (c) plural and possessive forms of the single-word slurs; (d) the remaining unambiguous pictographs of kinds already on the symbol list (houses of worship, pregnancy, older persons, guide dog, medical symbol). **Stop rule:** the round ends when Spanish natural-sentence coverage is within ten points of English on a fixed set Q and Viper agree, the direct statements on Viper's round-2 lists for B6 and B7 are held, there is no new false hold on any must-pass set (131 original, 167 corpus, TARS's 128 and Viper's 152 ordinary texts, except cases the SPEC already calls by design), and no further vocabulary work is done before the week.
- **R3-7.** TARS's one real test gap is closed. Every new class is in the known-answer corpus as must-hold, with ordinary neighbours as must-pass. The mutation check is re-run with mutants for the new rules.
- **R3-8.** SPEC 6A and its status line, the data-inventory addendum, the length wording and the re-rendered sample emails match the final code. (The governance documents are mine.)
- **R3-9.** Re-test on the final commit: TARS full run including off against the live parent; Sentinel on S2-A, R3-1, R3-3 and R3-4; Viper on the classes above only plus a regression sample; Judge on the delta; my own check that the final list is additions only against the v1 snapshot and that the audit event has the agreed keys.
- **R3-10.** Peter says yes to the final `wo-supp-v2` diff (Standard change), after seeing it. Version discipline: once the clock starts, any change to a term, rule or cleaner behaviour bumps the version and restarts the week.
- **S-1.** Peter's separate yes to change the setting to `shadow`, after Jarvis has told him in plain words: shadow reads real tenant- and vendor-written text on the server and nothing leaves it; only counts are stored, with no category names; the feature is a word list with no AI and holds ordinary words (the Question 1 note in Section 4); what the week will measure; and, ideally, the Mason checklist again.
- **S-2.** Scotty: the items in O-3 are done, and a maximum time is added to the cron call (Ralph).
- **S-3.** The repository is private (O-4).
- **S-4.** The week starts the day the fixed version is live in shadow; counts from that version only; review with Peter after day 3 and day 7.

**(c) Switch ON: BLOCKED.**
Today: the Missive exclusion is undecided and not deployed (hard gate); the shadow week has not run; Sentinel's S2-A and S2-C are open; round 3 has not happened; the human second look has not happened; Peter has not re-confirmed the Mason skip, the as-built option, or his acceptance of misses with real numbers; the decision record is unconfirmed; he has not been told the real block length (733). ON becomes possible to approve only when every item in Section 7 is ticked. If Peter says no to the exclusion, I would have to re-rule and do not expect to approve ON.

### 16.6 For Peter (through Jarvis)

1. Read the decision record (it now has the four questions and your reply word for word) and say "confirmed" in chat; Jarvis fills in the date.
2. Decide the Missive exclusion: yes (recommended) or no, after hearing the three consequences in Section 8.
3. Hear the real worst-case block length, 733 characters over six lines against "about 600", and accept it or choose a cut (for example a 250-character description, or a shorter fixed last line of 104 characters). Your "ok" covered the 300 and 100 limits.
4. Say yes to the final word list (a Standard change, additions only): the 213 added terms already in `wo-supp-v2` and the round-3 additions, once you have seen them as a diff.
5. Give a separate yes to each of: merge, deploy with the mode off, changing the setting to shadow, and much later ON.
6. Know that the audit rows will no longer carry category names, because your own rule says no protected-class data in any table. If you want them for tuning, say so; I would not.
7. Know the cost: some everyday alerts will show only the "open Latchel" sentence; the week measures how many.
8. Before ON: see the Mason checklist again and answer fresh; say yes again to the as-built version (word list only) once you have the week's numbers; say again whether misses are acceptable once you have the second look's count; sign off the sample emails; choose who does the 20-job second look.
9. Know that attorney review (Rule 6) was skipped on your instruction and the 30 or 90 day shadow (Rule 7) was not applied.
10. Make the GitHub repository private before anything from this branch is pushed. It is public today.
11. Optional: send the two legal questions (lawfulness and retention of the pod-inbox and Missive copies) to Mason or an attorney when you want to.

---

## 17. Final review of the third fix round, and the owner's overrides, 2026-10-16 (commit `2ab3d53`)

Reviewed: commit `2ab3d53` on `feature/work-order-alert-description`, on top of my documents (`ed6f884`) and `ce30374`. Inputs: Q's hand-off; TARS (FAIL, on one requirement); Sentinel (no S1; one new S2, S2-D; S2-B still open; clear for deploy with the mode off); Viper (bypasses found, none critical, none high: four narrow real gaps, two over-hold side effects, and the named residual classes); my own checks. **Not received:** Judge's delta review of `2ab3d53` and Ralph's re-run of the changed pieces, so both are carried as open. **The copy of Viper's list that reached me stops part-way through its third item**; I rule on the three I could read (17.3) and require Jarvis to hand over the rest. **The worktree:** no uncommitted edit of mine was left from the earlier review (`git status` showed only the untracked `node_modules` link); nothing was discarded; this commit adds only the two compliance files.

Section 17 governs where it differs from Sections 1 to 16.

### 17.1 What I checked myself

- **Whole suite on an extracted copy of `2ab3d53`** (my own scratch folder; the worktree was not written to): **188 of 188 pass** (81 alert, 15 cleaner, 20 corpus, 8 no-AI, 36 fix-round, 28 round-3).
- **No AI, again.** Fresh-process load of the alert module: 9 project modules, 0 forbidden (no model SDK, claim check, contextual classifier, notes check or classifier). In the five runtime files the vendor name appears once, in a comment; the environment reads are the alert's pre-existing ones (checked against the live parent) plus the two `WORK_ORDER_ALERT_*` switches. No network, file or child-process identifier. Nothing from the job text can leave the Hub process.
- **The word list, compared by program against snapshots of v1 (`1b33886`) and v2 (`ce30374`).** Terms: v1 911, v2 1,124 (+213), **v3 1,455 (+331)**. **0 removed and 0 changed at either step.** The 81 slur entries, the 328 everyday-word entries, the language list, the shared common terms and the 22-name vocabulary are identical to v1. Pair rules 9, 12, 13 (none of v2's missing); symbol groups 10 and 14 (none of v2's missing); 33 squashed phrases (a rule list). v3 additions by category: safety and violence 158, health 32, legal and eviction 27, age 27, benefits and income 22, minors 18, immigration and language 15, disability and health 10, familial status 9, marital status 9, religion and identity 3, arrest and criminal record 1; none is marked as an everyday word. **Additions only; nothing loosened.** It is a Standard change that needs Peter's OK, and he has not seen the diff.
- **The audit row.** Read the code: exactly eleven detail keys plus the trace (`latchel_job_id`, `trigger_source`, `mode`, `result`, `cause`, `common_word_only`, `screen_version`, `truncated`, `fallback_getjob_used`, `pod_unassigned`, `on_downgraded`). **No category name anywhere**: the summary result, the audit row and every log line are without one; the old key appears only in tests that assert its absence and in governance text that says it was removed. The review SQL no longer has the category query and counts `unsettled_text` on its own line (the SPEC's queries 1 to 4).
- **Slur literals:** 0 whole-word hits in the 26 changed files other than the terms file and 0 in the commit messages. One literal remains in the history of `0092ffe` (see the repository note below).
- **My fixed probe sets (the R3-6 stop rule), re-run on the new code:** English **72 of 74 held (97%, was 91%)**, Spanish **51 of 51 (100%, was 76%)**; Spanish minus English +2.7 points. **The stop rule is met on those sets.** Q built against them, so they overstate. Viper's fresh sets, which nobody tuned against: **English 67 of 80 (84%), Spanish 86 of 107 (80%)**, Spanish four points below English, still inside my ten. Single words in a neutral frame: 246 of 344 (about 7 in 10).
- **Spot checks through the real code path (stub only, no mail, no network):** the brand-looking Title-case shape holds the whole block with cause `local_screen`; a leading or doubled at-sign gets its host replaced; deeply nested entities hold with cause `unsettled_text` and one constant log line while ordinary double-escaped text settles; "N day notice" in its written forms (digits, number words, glued, business/court qualifiers, "notice of N days", "(N) day", Spanish) holds and an entry notice in hours is shown unless it ends in to-vacate-style wording; first-person violence and the Spanish widow, pregnancy and fear sentences hold; a straight double quote is shown as the double prime so it cannot close the quote around the description; ordinary repair text is shown.
- **Where the testers are right and Q's hand-off is not.** (i) **TARS's FAIL is real.** I swept every punctuation, symbol and space code point in the Basic Multilingual Plane as the separator in the Section 8 rule and in two other shared phrases (18,108 variants): ASCII marks and ordinary symbols all hold, but 163 code points are shown: 52 circled and parenthesised letters (which read as letters, an accepted look-alike class) and **111 compatibility symbols that Unicode folds into letters** (trade-mark-style marks, squared unit signs, the numero sign and similar). The fold reads them as letters, so the phrase is not seen. My R3-2 said "every run of characters that is not a letter or digit" and the round-3 brief said "every common symbol"; the trade-mark-style marks among those 111 are ordinary symbols a person can type, so the requirement is not met. (The chance that anyone types one there by accident is negligible; the requirement was set so that the phrase list cannot be defeated by punctuation, and it is cheap to meet.) (ii) **Sentinel's S2-D is real:** an address-looking word before an at-sign followed by one character is shown as typed (five forms shown). (iii) **Viper's gaps R2 and R3 are real:** a host directly followed by a non-ASCII number-like character is shown; third-person violence with a person noun as the object is shown (3 of my 5 forms). Q's hand-off listed none of them.

**The only figures that exist for how often a sensitive sentence slips through** are the ones in the bullets above. None is a real-world rate. Read plainly: of sentences that really are about health, family, religion, immigration, legal trouble, violence and the like, the list holds roughly four in five to nine in ten and shows the rest. How many real work orders contain such sentences is unknown; most contain none.

### 17.2 My conditions from Section 16.5, checked in code

| Condition | Result | Notes |
|---|---|---|
| R3-1 no category names in the audit row | **Met** | Code read, grep and the test; Sentinel S2-C closed; the review SQL no longer reads them. Peter must still be told (17.7) |
| R3-2 punctuation where the space belongs; Section 8 rule; squashed phrases | **Not fully met** | All 32 ASCII marks and about 60 common symbols hold on 71 shared phrases (TARS 22,368 variants, Viper 161,469, Sentinel 106,212 calls: 0 slips except the group below). The Section 8 rule and the 33 squashed phrases work. **The group of compatibility symbols that fold to letters is not held (R4-1).** The run-together class (609 of 700 phrases) is the accepted residual |
| R3-3 Title-case shape holds; at-sign rules; no exempt ending | **Met, with two gaps** | All 99 sentence-break endings hold the block; bare and doubled at-signs replaced; folded ordinal-mark links held; the 99-ending list is no longer an exemption. **Gaps: S2-D (R4-2) and Viper R2 (R4-3).** The SPEC status line says "no domain ending is exempt from the link rule any more"; the body correctly keeps the measurement endings. Tighten the status line (R4-6) |
| R3-4 unsettled text has its own cause and line | **Met** | Held, medium risk, one constant log line, not counted as a scanner error, alert still sent. Wording: the SPEC says "five or more levels", Viper measured six; correct the number (R4-6) |
| R3-5 "N day notice" | **Met** | Digits and number words, glued, qualifiers, "days of notice", "notice of N days", "(N) day", Spanish; hour-based entry notices pass unless followed by a to-vacate-style verb. Note: "2 days notice to order parts" is held too (the legal wording is held in any context; accepted false hold) |
| R3-6 bounded vocabulary round | **Met on the stop-rule sets; one gap** | Spanish parity and first-person wording are in (figures in 17.1). **Third-person violence with a person noun as the object (Viper R3) is the unfinished half of my R3-6(b)** (R4-4) |
| R3-7 corpus and mutation check | **Met, one open point** | Q 133 of 133 mutants caught; TARS's own 60 independent mutants: 57 caught, 3 survive (details in TARS's report). Close or explain the 3 (R4-6) |
| R3-8 documents and sample emails | **Met, with wording to fix** | 733 over 6 lines, typical about 330, 213 in v2 and 331 in v3 are consistent everywhere (TARS checked every document for the stale length and term-count figures of the earlier rounds, and a repo test does too; I re-checked). Twelve sample states re-rendered; I read them: held, unassigned, none, unavailable and shown all read as specified. Wording points in R4-6 |
| R3-9 re-test on the final commit | **Open** | TARS FAIL (one requirement), Sentinel S2-D, Viper real gaps; Judge and Ralph not in. Must be repeated on the round-4 commit |
| R3-10 Peter's yes to the final list | **Open; label accepted** | Q named the list `wo-supp-v3` instead of re-using `v2`, because five reviewers had already seen "v2" and its content changed. I accept that: v2 was never deployed, and a v1 to v2 to v3 diff is cleaner than a moving v2. If round 4 adds terms the label becomes `wo-supp-v4` and Peter is shown the delta |
| S-1 shadow yes | **Moot** | The week was declined (17.4). Changing the setting to `shadow` is no longer planned |
| S-2 Scotty: Node version, load check, cron time limit | **Not done** | Carried as O-3 (below) |
| S-3 repository private | **Open (Peter)** | Public when last checked; not re-checked in this review |
| S-4 the clock | **Moot** | No clock; version discipline now means: the commit hash and the `screen_version` string that are deployed are written into the decision record at ON |
| O-1 to O-6 (Section 16.5 a) | **Carried and updated in 17.5 (a)** | O-5 changes because the Missive exclusion is now deployed from its own branch |

### 17.3 Findings from the third round, and what I decided

"Round 4" is the last code round I ask for. It is small, every item is cheap, and it is followed by **one** re-test. After it I add no further vocabulary or rule work as a condition. Classes not listed here stay as the named accepted residuals in Section 9.

| # | Finding (class) | From | Decision |
|---|---|---|---|
| R4-1 | A shared phrase with a compatibility symbol (one that Unicode folds into letters) where the space belongs is shown. Digit-like marks must keep reading as digits for the notice and SSN patterns | TARS (the FAIL); my sweep | **Fix before ON.** Treat those symbols as separators in the word reading, without changing how digit-like marks read for the notice and SSN patterns. Test: every punctuation, symbol and space code point of the BMP and the astral planes as the separator in every shared multi-word phrase and in the Section 8 rule, expecting a hold, except circled and parenthesised letters, which are letters |
| R4-2 | The left-hand e-mail exemption: an address-looking word before an at-sign is shown as typed when what follows the at-sign is not a real host (one character, no dot, no ending) | Sentinel S2-D; Viper R1 | **Fix before ON (blocks ON for Sentinel).** Apply the exemption only when the part after the at-sign itself forms a host with a dot and an ending; otherwise replace the host before it. Real e-mail addresses stay (Peter's decision) |
| R4-3 | A host directly followed by a non-ASCII number-like or symbol character is shown as typed (the character is read as part of the last label) | Viper R2 | **Fix with R4-2** (same rule, same function): anything that is not an ASCII letter or digit after the ending ends the host |
| R4-4 | Third-person violence with a person noun as the object (relative, partner, child), English and Spanish: 14 of 38 on Viper's list shown | Viper R3 | **Fix before ON.** It finishes my R3-6(b); additions only, a Standard change. Stop rule: Viper's 38-item list held; zero new false holds on every ordinary set; nothing else added |
| R4-5 | The rest of Viper's list: the fourth real gap, the two over-hold side effects, and the remainder of item R3's examples | Viper | **Jarvis hands the full text to Q.** Q fixes every item Viper marks as a real gap and cheap; anything that would hold ordinary text goes to the false-hold residual (Section 9 item 4) |
| R4-6 | Wording and test points: SPEC status line; "five or more" vs six levels; TARS's three surviving mutants; the Sentinel note that "uncommon top-level domains" understates (most newer endings pass as bare hosts) | TARS; Sentinel; Viper | **Fix** (documents and tests only) |
| Accepted | Plain-label hosts on the everyday two-letter endings and on newer endings the list does not know (B5, S3-1); numbers with dots or slashes and the like (B9, S3-4); a whole one- or two-letter look-alike word (B10); wording that imitates a status line inside the quotes (B13 remainder); false holds from micro and ohm signs, abbreviation-heavy lines and long digit runs, and angle-bracket text vanishing (B14, B15); an exotic job id throwing past the handler (B16, pre-existing); event-loop cost (B17, worst measured about 0.4 second against a 1.5 second budget); the long tail of vocabulary | Viper; Sentinel | **Accepted residual classes**, already named in Section 9. Q's note that running the SSN pattern on the word reading would close one example cheaply stays a separate, later change |
| Pre-existing | Ralph's reconcile time budget, duplicate-email window, null error in the off-mode catch, failure-notice try/catch, duplicate pod-missing tasks; the cron time limit | Ralph; Scotty | Not part of this change; the cron time limit is Scotty's (O-3) |

### 17.4 The owner's overrides of 2026-10-16 (as relayed by Jarvis; quoted verbatim)

I did not see the chat. The task for this review gave me Peter's words, and I record them exactly. Under `CLAUDE.md` rule 3 an owner override stands when it is explicit, made in the moment and made with real information, and the relay says it was, so I record it as an override and rule on top of it. **Peter's "confirmed" on the decision record also confirms that these quotations and summaries are right.**

1. **The Missive copy.** Peter: **"yes stop copying them"** (the exclusion, `3f6922e`). Reported deployed and live since about 15:10 local on 2026-10-16. Not yet seen working on a real alert.
2. **The shadow week.** Peter, in the same message: **"no shadow period. ship it and make it work right away"**. Jarvis then showed him in plain words what the week would have measured (how often the screen withholds text; whether Latchel really sends the description on new work orders, never confirmed against a live delivery; the error rate at or below 5%; a human spot-check of 20 "shown" descriptions for misses, zero wanted by me; the Missive exclusion verified on a real alert) and what is at stake if it is skipped (a miss in the first days puts a tenant's sensitive words in two shared pod inboxes, Missive and the sent folder, from which they can only be cleaned up by hand).
3. **The faster check.** Jarvis offered a read-only run of the screen over the roughly 160 real past work orders on the server, counts and ticket numbers only. Peter: **"skip the check"**.

**Which of my earlier gates are now overridden by the owner (not met, never to be described as met):** the 7 consecutive days on the final version and the 40 screened attempts; the zero-scanner-errors measurement; the `unavailable` rate at or below 5%; the hold-rate and `common_word_only` review as a gate; the 20-job human second look with zero misses; the live-path canary in its 40-attempt form; the faster real-work-order check. Together with the earlier overrides they make four: attorney review (Rule 6), the 30 or 90 day shadow (Rule 7), the 7-day shadow week (Rule 6) and the faster check.

**What the overrides do NOT remove, and I will not waive:**

- **Rule 9 and the Fair Housing Standard** (never waivable): no housing decision is made or influenced by this feature, and the firewall tests stand.
- **The build rules that protect Peter's own standing rules:** no AI of any kind; the job text is never stored or logged; **no category names or other protected-class data in any table** (R3-1); no SSNs, bank accounts or passwords stored; fail closed; internal recipients only.
- **Fixes to real defects found by the testers** (R4-1 to R4-6). The overrides remove measurement, not repairs.
- **The Missive exclusion seen working on a real alert** before the interlock is set (the interlock is only an environment value) and still present after the last deploy of this feature.
- **Peter's "confirmed"** on the decision record (the date line stays blank until Jarvis fills it in).
- **Peter's sign-off** on the re-rendered sample emails, the word-list diff and the real block length (733 over 6 lines worst case, typical about 330, against "about 600").
- **The Mason checklist and the as-built version, put to him again at ON,** with the plain statement that no hold rate or miss rate was measured. His answer 3 covered building and deploying with the mode off; it was never a standing waiver for ON.
- **His separate, explicit yes to each of merge, deploy and switching ON** (`CLAUDE.md`, "Things I Never Want"). None of the answers above is a yes to any of them.
- **The tripwire:** a report of text that should have been held sets the mode to `off` the same day.

**What the overrides cost, in plain words.** The shadow week and the faster check were the only planned ways to learn, before live use, how often ordinary alerts are withheld, whether Latchel sends a description on new work orders at all, and how often a sensitive sentence slips through. None of that will be known on the first live day. The failures degrade safely (no description arrives: the email says so or shows the fixed sentence; a word-list miss: the text is shown, which is the risk Peter accepted in answer 2). What I recommend, and do not require, so that the cost is small: Peter or a pod lead reads the first 10 to 20 live blocks on the first day (they land in the pod inbox anyway), and Jarvis sends him the SPEC's counts (queries 1 to 4) at day 3 and day 7. The audit rows are written in `on`, so these cost nothing extra.

Pipeline note: `GOVERNANCE.md` says an owner who asks to skip a gate hears Jarvis refuse and explain first. The relay says Jarvis explained and offered a stricter alternative; it does not say whether Jarvis refused first. Noted, not held against anyone.

### 17.5 Verdicts and conditions

**(a) Deploy with the mode OFF: APPROVED WITH CONDITIONS.** Why: with the mode off or unset nothing in the new code runs on a job, the email is byte-identical to today's (TARS 3,112 comparisons incl. 14 settings of the switch and mail-failure variants; Judge 48 variants x 6 settings; Sentinel 143 runs with hostile text), nothing is stored, no AI is loaded and nothing leaves the server. Sentinel found it clear for deploy with the mode off. The approval applies to `2ab3d53` or any later commit that keeps the off email identical and passes the re-runs below. **My recommendation to Jarvis: deploy once, on the round-4 commit.** `2ab3d53` is safe to run dormant, but TARS has a red mark on it, so the PR table cannot show Tests green, and a second deploy costs a second Hub restart and a second yes from Peter.
- **O-1.** Judge reviews the delta on the exact commit to be deployed and signs off (never deferred).
- **O-2.** TARS re-runs on that exact commit (it must pass); Sentinel re-runs on S2-D, R4-2 and R4-3 if the commit is later than `2ab3d53`; Ralph re-runs the changed pieces (no-inbox path, guard clock, unsettled-text cause).
- **O-3 (Scotty).** The production Node version supports Unicode property escapes, lookbehind and `matchAll` (tested on Node 24 only); the alert module is loaded on the server with placeholder values and no network **before** the Hub is restarted (patterns compile at load even with the mode off); the direction of any difference with the server copy is checked before anything is overwritten; after the deploy `WORK_ORDER_ALERT_DESCRIPTION_MODE` is unset or `off` and `WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED` is unset or `no`; rollback is the previous release; the cron call gets a maximum time (Ralph).
- **O-4 (Peter).** The GitHub repository is made private **before any push** of this branch. It held the compliance files, the screening source, the term list and one slur literal in the history of `0092ffe`; it was public when last checked.
- **O-5 (changed).** **The Missive exclusion must survive the deploy.** It is deployed from its own branch and is not an ancestor of this one. The description deploy is file-scoped (the five runtime files and the comment-only `router.js` change), not a whole-Hub copy; Scotty confirms by hash that the intake files on the server are unchanged before and after; and the exclusion branch is merged to the mainline before or together with this one, so that git and the server agree and no later whole-Hub deploy puts the old intake code back. The PR table reads Legal = "OVERRIDDEN BY OWNER, not reviewed" with the link (never green, never N/A), and Tests, Red Team, Security and Quality are not green until re-run on the final commit.
- **O-6 (Peter).** A separate yes to merge, then a separate yes to deploy.
- **O-7.** The mode stays `off` after the deploy. Deploying is not switching on.

**(b) Switch ON: BLOCKED** on `2ab3d53` as built. It becomes approvable by me when **all** of these are true, on the final commit:
1. **Round 4 (R4-1 to R4-6) is done and re-tested:** TARS passes (including a sweep like the one in R4-1); Sentinel closes S2-D and has no open S1 or S2 (S2-B closes with item 3); Viper has no open real gap in R4-1 to R4-5; Judge has signed off the delta; Ralph has re-run the changed pieces; I have re-checked that the list is additions only against the v1 snapshot and that the audit row keeps its eleven keys and no category.
2. **No protected-class data in any table**, re-verified by me on the final commit (the audit row, the summary result, the logs, the review SQL), and the live row shape checked once the first real `description_checked` row exists (17.8, step 6).
3. **The Missive exclusion is seen working on a real alert**, read-only, counts and ids only: no new `missive_message_intake` row for it and the audit event `email_intake.work_order_alert_excluded` present, from an alert that arrived after the last deploy that touched the intake code; and the exclusion's code is still on the server after the description deploy (O-5).
4. **Peter has said "confirmed"** on the decision record; Jarvis has written the date.
5. **Peter has signed off** the sample emails re-rendered on the final commit, the word-list diff (v1 to v2 to v3, plus any round-4 delta), and the real block length (accept 733 or choose a cut).
6. **Peter has answered fresh, at the moment of ON,** the Mason checklist (yes or no to skipping it), the as-built version put in plain words (a word list, no AI, ordinary words hold, no measured hold rate or miss rate, the figures in 17.1), and whether a miss is acceptable. Jarvis records each answer and the date in the decision record.
7. **Peter has given a separate, explicit yes to switch ON,** and Asimov has given the activation confirmation (this section plus a short written confirmation once items 1 to 6 are true).
8. Scotty (O-3), the repository (O-4) and the PR table (O-5) are done.
Items overridden by the owner (17.4) are not on this list. **If the Missive evidence fails, or Peter reverses the exclusion, ON stays blocked.**

**(c) Shadow:** no longer a gate. If Peter ever asks for it, it needs its own yes, and it would be the right way to measure the rate.

### 17.6 PR checklist rows (GOVERNANCE.md Integrity Rules 1 and 3)

| Gate | Specialist | At `2ab3d53` | Must read on the final commit |
|---|---|---|---|
| Branch | Jarvis | feature branch | `feature/work-order-alert-description` |
| Schema | Neo | N/A | No schema change, no migration |
| Backend | Q | round 3 done, round 4 open | Round 4 done |
| Infra | Scotty | not done | Node, load check, file-scoped deploy, exclusion intact (O-3, O-5) |
| Tests | TARS | **FAIL (one requirement)** | PASS on the final commit only |
| Chaos | Ralph | not re-run | Changed pieces re-run, pre-existing items listed |
| Red Team | Viper | **BYPASSES FOUND** (none critical or high) | Real gaps closed; residual classes named |
| Security | Sentinel | S1: 0, S2: S2-D open, S2-B open until the real-alert evidence | S1 0, S2 0 |
| Governance | Asimov | deploy OFF approved with conditions; ON blocked | Link to this document |
| Legal | Mason | **OVERRIDDEN BY OWNER, not reviewed** | Same, with the link to the decision record. Never green, never N/A |
| Quality | Judge | not received for this commit | Delta signed off on the final commit |
| Shadow / faster check | Asimov | **OVERRIDDEN BY OWNER, not run** | Same line in the PR body: "Shadow week and real-work-order check declined by the owner on 2026-10-16" |
| CI | TARS and Jarvis | pending | |

### 17.7 What Peter must still do or hear, in order

1. Say **"confirmed"** on the decision record. That also confirms the quotations in 17.4 are accurate. Jarvis writes the date.
2. **Make the GitHub repository private.**
3. Nothing during round 4 (Q fixes, the testers re-run once).
4. See and sign off, on the final commit: the sample emails, the word-list diff and the real block length.
5. Say yes to **merge**; then, separately, yes to **deploy with the mode off**.
6. Hear the result of the Missive check on the first real alert (Jarvis reports).
7. At ON: the Mason checklist, the as-built version and the acceptance of misses, answered fresh; then a separate **yes to switch ON**.
8. Know: the audit rows carry no category names (a reduction, in line with his own rule); the two costs of the exclusion (staff replies in an alert thread are not archived; the check trusts the sender Missive shows); some ordinary alerts will show only the "open Latchel" sentence; the feature is a word list with no AI; attorney review and every shadow period were skipped on his instruction; and the tripwire.

### 17.8 How to switch ON, and how to switch OFF in an emergency

**The two environment values** (on the server, in the Hub's `.env` file at `/var/www/hub/.env`; the Hub reads the file beside `server.js` first, and otherwise the one two folders up; Scotty checks which exists, and never prints the file, only these two lines). Values are read exactly: only lowercase `on` or `shadow` count; `ON`, `On`, a blank or anything else means `off`. `on` takes effect only when the interlock is exactly `yes`; otherwise the Hub behaves as `shadow` (reads text, writes counts, sends nothing) and logs one constant line. The values are read when the Hub starts; **a restart of the Hub is what applies a change** (`pm2 restart hub --update-env`, which restarts every tool in the Hub for a few seconds).

**Who:** Scotty (or Jarvis through the terminal) edits the file, on Peter's explicit yes relayed by Jarvis. Peter does not touch the server.

**Switch ON** (only when every item in 17.5 (b) is true and written in the decision record with the date, the commit hash and the `screen_version` string):
1. *Pre-flight (read-only).* The five runtime files on the server equal the reviewed commit's; the Missive exclusion code is present in the intake file; the two lines read `WORK_ORDER_ALERT_DESCRIPTION_MODE=off` and `WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED=no` (or unset).
2. *Evidence.* Jarvis or Scotty runs the read-only check from 17.5 (b) item 3 and shows Peter the result in plain words.
3. *Peter's fresh answers and his separate yes* (17.5 (b) items 4 to 7), written in the decision record.
4. *Edit exactly two lines:* `WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED=yes`, then `WORK_ORDER_ALERT_DESCRIPTION_MODE=on`. Keep the old two lines in the change note.
5. *Restart:* `pm2 restart hub --update-env`, at a quiet moment, told to Peter first; confirm the process is online and the health check answers.
6. *Verify:* (a) the logs do **not** show the "interlock is not set" line (that line means `on` was downgraded to `shadow`); (b) on the next real alert, the email in the pod inbox carries either the "What the work order is" block or the fixed held sentence, and `audit_log` has a `work_order_note_alert.description_checked` row with `mode` = `on`, `on_downgraded` = false, the agreed eleven keys and no category; (c) the Missive exclusion is seen working again on that alert (no intake row); (d) recommended: Peter or a pod lead reads the first 10 to 20 live blocks that day. Write the time, who and what was checked in the decision record.
7. *Afterwards:* Jarvis sends Peter the SPEC's counts (queries 1 to 4) at day 3 and day 7. Adding words is a Standard change (Peter's OK, version bump); removing or loosening anything is Critical (Asimov re-review).

**Switch OFF, in an emergency** (any time; Peter's word, relayed by Jarvis, is enough; if a miss is suspected, do this first and ask afterwards):
1. Set `WORK_ORDER_ALERT_DESCRIPTION_MODE=off` in the same file (removing the line has the same effect; do **not** use the interlock as the off switch, because `on` without the interlock still reads text as `shadow`).
2. `pm2 restart hub --update-env`; confirm online.
3. *Verify:* the next alert email has no "What the work order is" block at all (identical to the email from before the feature), there is no new `description_checked` row after the restart time, and the logs are clean. This takes about a minute plus the restart; no code change and no deploy is involved.
4. *Afterwards:* the emails already sent stay in the pod inboxes, Missive and the noreply sent folder; the audit rows give the job ids (ids only) to find them. Deleting them is a manual search and is Peter's separate decision. Report the miss to Asimov the same day, extend the list (Standard change), re-run the tests; switching back to ON needs the checks in 17.5 (b) items 1 to 7 again, with Peter's fresh yes.

---

## 18. Final review of the fourth fix round, and Peter's replies to Jarvis's three questions, 2026-10-16 (commit `c781a1b`)

Reviewed: commit `c781a1b` on `feature/work-order-alert-description`, on top of my documents (`7f7dc26`) and `2ab3d53`. Inputs: Q's hand-off; TARS (**PASS**); Sentinel (no S1, no S2 open; S2-D closed); Viper (bypasses found, **none critical, none high**); Ralph (**RESILIENT**, no blockers); my own checks. **Not received: Judge's delta review of `c781a1b`**, so it is carried as open (O-1, never deferred). **The copy of Viper's list that reached me stops part-way through her second item, the same defect as last round.** I read her N1 and N2 in full and cannot rule on N3 onward; her summary says the rest are two more narrow real gaps, two over-hold side effects, one documentation inaccuracy and two test-pin survivors, and that none blocks the deploy with the mode off. I rule on what I read, apply my stop rule to the rest, and make the one thing that could matter to a compliance document (the documentation item) a condition (O-8). **The worktree:** no uncommitted edit of mine was left from the earlier review (`git status` showed only the untracked `node_modules` link); this commit adds only the two compliance files.

Section 18 governs where it differs from Sections 1 to 17. Section 17 stays as the record of the third-round review.

### 18.1 What I checked myself

- **Whole suite, in the worktree, scrubbed environment:** **209 of 209 pass** (81 alert, 15 cleaner, 20 corpus, 8 no-AI, 36 fix-round, 27 round-3, 22 round-4). The run left the worktree untouched.
- **The exhaustive separator sweep (`test/sweep-full.js`), run by me:** 72 shared phrases, 8,887 punctuation, symbol and space code points of every plane as the separator (605 single-letter forms excluded by design), **639,864 variants, 0 slips**. The earlier "0 slips" claim had skipped exactly the characters that fold to letters; this one does not.
- **The mutation check (`test/mutation-check.js`), run by me in a scratch copy:** **167 of 167 mutants caught, 0 survived or did not apply** (it breaks a copy one way at a time and checks that a test fails; it includes the new v3 and v4 term-removal mutants, the typed-symbol and at-sign mutants, the hour-notice pattern, both over-holding link shapes and the `link_shape` cause).
- **My own probes, through the real path (stub only, no network):** 765 variants of 17 phrases (shared, feature-local, Section 8, a violence phrase) with 15 separators including the trademark, service-mark, numero, care-of, degree-Celsius, ordinal, squared-unit and section signs, in the description, in the title: **0 slips**. Ordinary text with those marks (a branded faucet, a unit number sign, a pipe size with a fraction, a temperature, a code citation, a mail "care of" line) is shown. Digit-like marks still read as digits (a superscript or circled digit in an "N day notice", a Social Security number and a card number are held). Links: **12 of 12** shapes that must be replaced are replaced (a web-like word before an at-sign with a one-label or odd domain, and a host followed directly by a superscript, a fraction, a circled digit, an ordinal mark or an accented letter); **10 of 10** ordinary shapes stay (real e-mail addresses, a unit like 5.mm, "approx.2", "No.5/6").
- **The word list, compared by program against the real historical files in git** (v1 `0092ffe`, v2 `ce30374`, v3 `2ab3d53`, not the fixtures), against v4: terms 911, 1,124 (+213), 1,455 (+331), **1,511 (+56)**. **0 removed and 0 common-flag changes against each of v1, v2 and v3; no pair-rule word removed or narrowed; the 14 symbol groups and 33 squashed phrases kept; the 81 slur entries, the 328 everyday words, the language list and the 22-name vocabulary identical.** The 56: safety and violence 38, immigration and language 4, source of income 14; **none is marked as an everyday word.** Pair rules 13 to 16 (violence done to a named person in English and in Spanish; first-person Spanish "from" a country). **Additions only; nothing loosened. The label `wo-supp-v4` is right and accepted.** I also checked, independently of Q's test, that **every one of the 213 v2, 331 v3 and 56 v4 added terms holds inside a natural sentence** (213, 331 and 56 of them), and that the snapshot fixtures equal the real historical files exactly (terms and common marks: 0 missing, 0 extra, for v1 to v4). Differentials over 18,000 sensitive-heavy random strings (two seeds) through the real summary path found **0 strings held on v3 and shown on v4** (3,649 newly held) and, on 25,000 generated ordinary maintenance sentences, 0 new holds. (It is a Standard change that needs Peter's OK; he has not seen the diff.)
- **The stop rule on ordinary text.** Dictionary scan of 235,976 words: 1,367 hold alone on v3, **1,371 on v4; newly held exactly four (molester, molestation, spank, spanking); none lost.** A differential of v3 against v4 on **1,800** sentences of my own (30 parts x 20 faults x 3 endings, including "hit by the truck", "kicked loose", "punched out", "stabbed by a screwdriver"): **0 held in either, 0 new.** Twenty ordinary sentences using family words: the same four hold on v3 and on v4 (all older rules), none new. TARS and Viper report 0 new false holds on every ordinary set named in the stop rule. **Stop rule met.**
- **Violence wording.** My own 18 fresh sentences (English and Spanish, with a person noun or pronoun as the object): **18 of 18 held.** Viper's 38-item list: 38 of 38 held (TARS, Viper). The passive and noun-first shapes are still shown for 4 of my 5 (18.3, N1).
- **No AI.** The four runtime files that matter contain no network, model, file, child-process or environment identifier other than the two `WORK_ORDER_ALERT_*` switches; the screen requires only the frozen shared terms file, its own terms file and the cleaner; the alert module's only new `require` is the summary module; `no-ai-proof.js` passes 8 of 8 (TARS: 592 alert runs, 0 outbound calls, 0 forbidden modules).
- **The audit row.** Code read: exactly eleven detail keys plus the trace (`latchel_job_id`, `trigger_source`, `mode`, `result`, `cause`, `common_word_only`, `screen_version`, `truncated`, `fallback_getjob_used`, `pod_unassigned`, `on_downgraded`). The only change is one new value of `cause`, `link_shape`. **No category name anywhere** (TARS 360 runs and Sentinel 200 runs: 0 leaks, 0 category names, 0 job text).
- **Slur literals:** 0 whole-word hits in the added lines of the 30 changed files other than the terms file, 0 in the commit messages. The squash note is in 18.4.
- **Real data:** a scan of every added line found no real person's address, no non-synthetic phone number and no key or token; the one real address is the company's own noreply sender, already named in the documents.
- **Off mode and frozen files.** `router.js` differs from the live parent by comments only; `maintenance-history`, `email-intake`, `archive-search`, `lib`, `supabase` and the package files show no diff against the parent. The deploy list is the same five runtime files (plus the comment-only `router.js`). The off-mode email is byte-identical to today's (TARS: 3,784 comparisons; Ralph: 2,178 runs; Sentinel: 143).
- **Sample emails, re-rendered by me** (`test/render-samples.js`, stub mailer): 12 states, block lengths 61 to 578 characters; the held, unassigned, none and unavailable sentences read as specified, and the closing line states 733 characters worst case, about 330 typical, about 600 soft target not met.

### 18.2 My round-4 conditions (R4-1 to R4-6), checked in code and by probe

| Condition | Result | Notes |
|---|---|---|
| R4-1 symbols that fold to letters, typed where a space belongs | **Met** | 315 characters are now read as spaces through a fourth set of readings and the screen's own typed-symbol reading; the section sign reads as the word "section"; digit-like marks and circled, parenthesised and squared letters are left alone on purpose, and the SPEC and Section 9 item 6 say exactly what the sweep proves and leaves out. Full-plane sweep: 0 slips (mine 639,864 variants; TARS about 2.05 million; Sentinel 1.26 million; Viper about 2.4 million; Ralph 194,540). The old sweep test that skipped those characters was removed |
| R4-2 the left-hand e-mail exemption (Sentinel S2-D, Viper R1) | **Met** | A web-like word before an at-sign is kept only when what follows the at-sign is itself a host with a dot and a listed ending; real addresses stay (Peter's decision). Sentinel: closed in both directions; Viper: 13 of 13 forms replaced, ordinary addresses intact |
| R4-3 the host ends at any non-ASCII character (Viper R2) | **Met, with a readability cost** | A host followed by a superscript, fraction, circled digit, ordinal mark or accented letter is replaced. Q applied it literally: a Spanish word that begins with a listed ending and continues with an accented letter, typed with no space after a full stop, reads "[link removed]" plus the rest. Never a hold. **Accepted** and recorded in Section 9 item 14. It only adds replacements (Sentinel, Viper, Ralph: nothing replaced before is shown now) |
| R4-4 third-person violence with a person noun as the object | **Met on the agreed list; one shape remains** | Viper's 38 of 38 and my 18 of 18 held; zero new false holds. The mirrored order (person first, passive verb) is not covered (18.3, N1) |
| R4-5 the rest of Viper's cheap real gaps | **Met for what I can see** | First-person Spanish forms of the phrases already held in the third person, the Spanish pair-rule completion and the Section 8 program names are in. I cannot see her N3 onward (O-8) |
| R4-6 wording, tests and documents | **Met** | SPEC status line now says the measurement endings are the one exemption; the nesting wording says six passes (five levels settle, six do not), confirmed by Ralph and TARS at the boundary; Section 9 item 8 records the digits-plus-unit exemption including the endings that are real country domains (ml, ma, mw, mv, kw); the 12 samples carry the honest block length; the data inventory has the fourth-round addendum |
| The v3 pin (Judge, TARS) | **Met** | A snapshot of v3 and one of v4 sit beside v1 and v2; one test fails if any term, common flag, pair-rule word, symbol or squashed phrase of any of them is missing or changed; each v3 and v4 term must hold inside a natural sentence. Deleting "hurting me", "tiene pension" or "had a gun" now fails a test |
| TARS's surviving mutants | **Met** | The hour-notice pattern and the two over-holding link shapes are pinned. TARS re-ran Q's check (167 of 167 caught, 0 survive) and wrote 47 mutants of his own (41 caught; of the 6 that survive, 3 are equivalent edits and 3 are low-severity test gaps); Viper wrote 32 (30 caught; 2 survive the five fast test files, which is her test-pin item and is covered by O-8) |
| TARS minor item: cleaner-requested holds counted apart | **Met, in a different way than I suggested** | See decision (a) below |

**Decision (a): the cleaner-hold cause is `link_shape`, not `local_screen` plus a marker. Accepted.** I suggested local_screen with a distinguishing constant; Q found the audit row has no spare key and that `common_word_only` would be a false statement, so the hold has its own constant cause value. This adds no key and no category, it is the same route I took for `unsettled_text`, nothing outside the feature reads the cause, and Sentinel has no objection. **What it means in plain words for Peter:** `local_screen` now means "the word list fired" more exactly than before (the missing-space shape used to be mixed into it), and the review SQL counts `link_shape` on its own line. It reveals nothing about a household.

**Decision (b): R4-3 applied literally. Accepted** (above). **Decision (c): the label `wo-supp-v4`. Accepted** (18.1). **Decision (d): "spanking" is held although "brand spanking new" is an ordinary phrase. Accepted** (Viper's list required it; it is one of the four newly held dictionary words) and told to Peter in plain words in the decision record.

### 18.3 Findings from the fourth round, and what I decided

I said last round that round 4 would be the last code round I asked for, with one re-test and no further vocabulary or rule work as a condition. **I stand by that.** Nothing below is a condition for the deploy or for ON except where marked.

| # | Finding (class) | From | Decision |
|---|---|---|---|
| N1 | Violence done to a named person written with the person first and a passive verb is shown for 6 of 14 such forms in the red team's set and held for 8 (my own set of 14: the same, 6 shown; the object-first order was closed by R4-4) | Viper N1 (real gap, low to medium) | **Accepted residual, named; not a condition.** It is the same long-tail class as Section 9 item 7, outside the 38-item list I set as the stop rule. It is cheap (the mirrored order inside the same pair rule) and **I recommend it as the first Standard addition after ON, or when the tripwire fires**, after a check for new false holds (some will hold: a child hurt by a car). The examples are not written here because the repository is public |
| N2 | Violence verbs and indirect phrasing not on the list; and the earlier long-tail items (some nationality words, "someone is watching my unit") | Viper N2 (accepted class) | **Accepted residual classes**, already named in Section 9 item 7. `push`, `grab`, `attack`, `baby`, Spanish `mata`, `lastima`, `ataca` were deliberately not added because they hold ordinary text; I agree |
| N3 onward | Viper's remaining items: two more narrow real gaps, two over-hold side effects, one documentation inaccuracy, two test-pin survivors (test files only; the product code is right) | Viper (cut off in my copy) | **Not seen.** Behaviour items are accepted under the stop rule because Viper rates none critical or high and says none blocks the deploy with the mode off. **O-8: Jarvis hands me the full text; a documentation inaccuracy in a compliance document is corrected before the deploy (documents only, no new code round); the two test-pin survivors are pinned by Q or noted as equivalent when the full suite is run on the mutant** |
| R6 | Two ordinary words whose letters happen to contain a squashed phrase hold (for example environmental health, because mental health sits inside it; 6,063 dictionary word pairs) | Viper R6 (over-hold) | **Accepted false hold.** The cheap fix (match the squashed phrase only on whole-word boundaries) would loosen a hold rule, which is a Critical change; Q was right not to make it. Costs one sentence, no safety effect. Section 9 item 4 |
| S3-N2 | A number-only name on ml, ma, mw, mv or kw (also real country domains) is shown, as with the other measurement endings | Sentinel; TARS | **Accepted residual**, recorded in Section 9 item 8 as I asked |
| S3-N3 | The Devanagari ending is a dead entry on the link list (its vowel signs are marks, which the ending test rejects) | Sentinel; TARS | **Accepted residual** (uncommon ending). The fix is cheap (allow marks in the ending test and the label class); Q may do it with any later change, not a condition |
| S3-N4 | The cleaner's time-budget error is counted under `unsettled_text`, so a slow server or a future slowdown would read as "text the job caused" | Sentinel | **Accepted, with a reading rule for the day-3 and day-7 counts:** a sudden rise in `unsettled_text` is to be treated first as a possible slowdown of the Hub, not as tenant text. Worst case measured by TARS 436 ms, Ralph 1.55 s once on a loaded machine, against the 1.5 s budget; the failure is safe (the block is held, the alert still goes out) |
| S3-N5 | Bare web addresses on uncommon or everyday two-letter endings pass; the SPEC says "uncommon" | Sentinel | **Accepted residual**, named in Section 9 item 8 |
| Ralph | Cron call: `curl -m 300 --connect-timeout 10`; module load check; optional stop after two lookup timeouts | Ralph | The first two are Scotty's (O-3). The third is **not required** |
| Info | Repeated: the remaining classes (letter splitting, run-together beyond the squashed list, one-letter look-alike words, status-line imitation, the long vocabulary tail) | all | **Named accepted classes**, unchanged, Section 9 |
| Side effects | "brand spanking new"; Costa Mesa and La Cañada after "soy de" or "vengo de" (the first-person country rule reads "Costa" and "Cañada" as countries); "pension de" and "abuelo" from v3 | Q; TARS | **Accepted false holds**, told to Peter in plain words |

### 18.4 Peter's replies to Jarvis's three questions, and how I record them

Recorded verbatim in the decision record ("Peter's replies to Jarvis's three questions"). Peter's whole reply, as relayed: **"1 confirmed 2. accept it 3. ignore and treat as normal"**. I did not see the chat.

1. **"confirmed" (2026-10-16): the four questions and four answers are confirmed.** The "date confirmed" line in the decision record is filled in (by me, at Jarvis's instruction). **I am narrowing my own earlier condition and saying so:** in Section 17 I wrote that his "confirmed" would also confirm the quotations of his later messages. The question Jarvis actually put to him described the record as "our four questions and your four answers, word for word", and he had not seen those quotations. So **the later-decision quotations and the summaries of what Jarvis showed him (the Missive copy, the shadow week, the faster check) are not yet confirmed; Jarvis puts them to him again with the final record at ON.** This does not weaken anything: the owner overrides stand as relayed, and they are never described as met.
2. **"accept it": the real worst-case block length is accepted.** 733 characters over six lines at most (a ceiling; TARS reached 723 with the real category labels), typical about 330, soft target about 600 not met, no cut. This closes the block-length item in my ON gate. It holds for the limits as built (title 100, description 300, fixed last line 104 characters); if one changes, the question is asked again. It does not replace his sign-off on the sample emails or the word-list diff.
3. **"ignore and treat as normal": the repository caution is accepted by the owner.** This is an owner override of my condition O-4 (repository private before any push). Jarvis put my condition and the stake to him and he answered it directly, so under `CLAUDE.md` rule 3 it stands; it is not a thing nobody can waive (the repository holds no tenant data from this feature, only synthetic test data, and Rule 9 and the Fair Housing Standard are untouched). **One fact the question did not contain, which I record so his answer is judged on the whole of it:** Jarvis's mitigation is `git merge --squash`, which removes the stray literal from the history of the first build commit. It does not remove the slur list from the tree: **the terms file `work-order-text-screen-terms.js` holds the 81 slur entries and the whole screening vocabulary written out, because the screen needs them, and it is the one file where that is allowed.** A push to a public repository publishes that file. **Nothing needs deciding now** (deploying involves no push). **At the moment of any push, Jarvis tells Peter that one sentence and asks once more; his answer then stands.** My recommendation that the repository be private is unchanged, and it is a recommendation now, not a gate.

### 18.5 Verdicts and conditions

**(a) Deploy with the mode OFF: APPROVED WITH CONDITIONS** for `c781a1b`. Why: with the mode off or unset nothing in the new code runs on a job, the email is byte-identical to today's, nothing is stored, no AI is loaded and nothing leaves the server. TARS passes on this exact commit, Sentinel has no S1 and no S2 open, Ralph found it resilient, Viper found nothing critical or high. This is also the commit to deploy: one deploy, one Hub restart, one yes.
- **O-1.** Judge reviews the delta on the exact commit to be deployed and signs off. Not received; never deferred.
- **O-2.** Met on `c781a1b`: TARS pass, Sentinel clear, Ralph resilient. **Any later commit that touches the five runtime files or the terms file goes back through TARS and Sentinel at least, and through me for the list.**
- **O-3 (Scotty).** The production Node version supports Unicode property escapes, lookbehind, sticky patterns, `matchAll` and `process.hrtime.bigint` (tested on Node 24 only). The alert module is loaded on the server with placeholder values and no network **before** the Hub is restarted (patterns compile at load even with the mode off, and a missing dependency fails the load). The direction of any difference with the server copy is checked before anything is overwritten. After the deploy `WORK_ORDER_ALERT_DESCRIPTION_MODE` is unset or `off` and `WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED` is unset or `no`. The cron call gets a maximum time (`curl -m 300 --connect-timeout 10`, Ralph). **The deploy changes no cron wiring: if the reconcile cron is not yet live, wiring it or running it for the first time is a separate decision with its own yes** (a reconcile job's first run treats its whole look-back window as new; an earlier build sent 32 real emails that way on 2026-09-22, as recorded in Jarvis's notes). Rollback is the previous release.
- **O-4 (changed).** Peter's "ignore and treat as normal" stands for the deploy, which involves no push. At the moment of any push, the one-sentence re-ask in 18.4.
- **O-5.** The deploy is file-scoped (the five runtime files plus the comment-only `router.js`, never a whole-Hub copy). Scotty confirms by hash that the email-intake files on the server are unchanged before and after. The Missive exclusion branch (`3f6922e`) is merged to the mainline before or together with this one, so that git and the server agree and no later whole-Hub deploy puts the old intake code back. The PR table reads as in 18.6.
- **O-6 (Peter).** A separate yes to merge (Jarvis uses `git merge --squash`), then a separate yes to deploy.
- **O-7.** The mode stays `off` or unset after the deploy. Deploying is not switching on.
- **O-8.** Jarvis hands me Viper's full list from N3 onward. A documentation inaccuracy in a compliance document is corrected before the deploy; behaviour items are accepted under the stop rule unless Viper rates one high or critical (her summary says none is).

**(b) Switch ON: APPROVED WITH CONDITIONS.** I have no remaining objection to the code, the design or the tests at `c781a1b`. **This is not the activation confirmation.** I give that only when all of these are true, on the final commit, and written in the decision record with the date, the commit hash and the `screen_version` string (`protected-class-terms-v2+wo-supp-v4`):
1. Judge has signed off the delta; O-3 to O-8 are done; **the five runtime files on the server equal `c781a1b`'s by hash.**
2. **The Missive exclusion is seen working after the description deploy.** The code is still on the server by hash, and the first real alert sent after that deploy shows no new `missive_message_intake` row and the audit event `email_intake.work_order_alert_excluded`. The evidence already reported (alert #161 sent at 22:56Z on 2026-10-16: not stored, stored copies still 153, two exclusion events at 23:00:11Z with reason `sender_and_subject`) is accepted as relayed for the earlier state; it does not cover the state after this deploy. If the evidence fails or Peter reverses the exclusion, ON stays blocked.
3. **Peter has signed off, on the final commit,** the 12 re-rendered sample emails and the word-list diff (v1 to v2 to v3 to v4; the v4 delta is 56 terms and 3 pair rules, additions only, with the plain-English side effects). The block length is already accepted (18.4).
4. **Peter has answered fresh, at the moment of ON:** the Mason checklist (yes or no to skipping it); the as-built version in plain words (a word list, no AI, ordinary words hold, **no hold rate or miss rate was measured**, and the only figures that exist: Section 17.1); whether a miss is acceptable; and he has **confirmed or corrected the later-decision quotations** (18.4, item 1). Jarvis records each answer and the date.
5. **No protected-class data in any table**, re-verified by me on the first real `description_checked` row (eleven keys, no category; `cause` one of null, `local_screen`, `link_shape`, `unsettled_text`, `check_error`, `pod_unassigned`, `summary_error`).
6. **Peter's separate, explicit yes to switch ON,** and my written activation confirmation.
Standing rules that no override removes: Rule 9 and the Fair Housing Standard, no AI of any kind, nothing from the text stored or logged, no category names or protected-class data in any table, no SSNs, bank accounts or passwords stored, fail closed, internal recipients only, and the tripwire (a report of text that should have been held sets the mode to `off` the same day). Items overridden by the owner (17.4) are not on this list.

**(c) Shadow:** no longer a gate (Section 17.5 c).

**Remaining gates, in one list:** Judge's sign-off; Viper's unseen tail (documents); Scotty's checks; Peter's yes to merge and then to deploy; Peter's sign-off on the sample emails and the word-list diff; the Missive exclusion seen again after the deploy, with its code confirmed by hash; Peter's fresh answers at ON; Peter's separate yes to switch ON; my activation confirmation; the PR table filled in honestly; and, at any push, the one-sentence re-ask.

### 18.6 PR checklist rows (GOVERNANCE.md Integrity Rules 1 and 3)

| Gate | Specialist | At `c781a1b` | Must read on the final commit |
|---|---|---|---|
| Branch | Jarvis | feature branch | `feature/work-order-alert-description` (squash-merged) |
| Schema | Neo | N/A | No schema change, no migration |
| Backend | Q | round 4 done | Same |
| Infra | Scotty | not done | Node, load check, file-scoped deploy, exclusion intact by hash (O-3, O-5) |
| Tests | TARS | **PASS** (209 of 209; 167 of 167 mutants caught) | PASS on the deployed commit |
| Chaos | Ralph | **RESILIENT**, no blockers | Same; cron time limit is Scotty's |
| Red Team | Viper | **BYPASSES FOUND, none critical or high**; residual classes named and accepted (18.3) | Same, with her unseen tail resolved (O-8) |
| Security | Sentinel | S1: 0, S2: 0 | Same |
| Governance | Asimov | deploy OFF approved with conditions; ON approved with conditions (no activation confirmation yet) | Link to this document |
| Legal | Mason | **OVERRIDDEN BY OWNER, not reviewed** | Same, with the link to the decision record. Never green, never N/A |
| Quality | Judge | not received for this commit | Delta signed off on the final commit |
| Shadow / faster check | Asimov | **OVERRIDDEN BY OWNER, not run** | Same line in the PR body: "Shadow week and real-work-order check declined by the owner on 2026-10-16" |
| CI | TARS and Jarvis | pending | |

### 18.7 What Peter must still do or hear, in order

Done already, on 2026-10-16: "confirmed" (four questions and answers), "accept it" (733 characters), "ignore and treat as normal" (repository, with the push-time re-ask), and round 4 itself (he was asked for nothing during it).

1. See and sign off, on the final commit, the **12 sample emails** and the **word-list diff** (the v4 delta). Jarvis shows him both.
2. Say yes to **merge** (squash); then, separately, yes to **deploy with the mode off**. Before any **push**, hear the one sentence about the slur list in the terms file and answer again.
3. Hear Scotty's results and the second real-alert check of the Missive exclusion (Jarvis reports).
4. At ON: the **Mason checklist**, the **as-built version**, **whether a miss is acceptable**, and the **later-decision quotations**, answered fresh; then a separate **yes to switch ON**.
5. Know: the audit rows carry no category names; the two costs of the Missive exclusion (staff replies in an alert thread are not archived; the check trusts the sender Missive shows); some ordinary alerts will show only the "open Latchel" sentence; "brand spanking new" and two place names now hold; violence written with the victim first and a passive verb can still slip through; the feature is a word list with no AI; attorney review and every shadow period were skipped on his instruction; and the tripwire is the safety net. Optional and recommended: Peter or a pod lead reads the first 10 to 20 live blocks on day one, and Jarvis sends him the SPEC's counts at day 3 and day 7.

### 18.8 How to switch ON, and how to switch OFF in an emergency

Section 17.8 applies unchanged, with these updates: in step 1 the five runtime files are compared with `c781a1b`'s (or with the final reviewed commit's) by hash; in step 2 the evidence is the first real alert sent after the description deploy; in step 3 Peter's answers include the later-decision quotations; the `cause` values to expect in step 6 include `link_shape`. The emergency switch OFF is unchanged.

---

## Final governance status

```
feature:             Work Order Alert: optional job title and description block (spec Section 6A)
build reviewed:      commit c781a1b on feature/work-order-alert-description (base 058618d); documents on top of it (Section 18)
verdict, deploy OFF: APPROVED WITH CONDITIONS (O-1 to O-8, Section 18.5 a); this is the commit to deploy
verdict, ON:         APPROVED WITH CONDITIONS (Section 18.5 b): no remaining governance objection to code, design or tests at c781a1b;
                     NO activation confirmation yet. Still to be true: Judge's sign-off; deploy done and the five runtime files
                     confirmed by hash; Missive exclusion still on the server and seen excluding the next real alert after the deploy;
                     Peter's sign-off on the 12 sample emails and the word-list diff; his fresh Mason, as-built, miss-acceptance and
                     later-decision answers at ON; his separate yes; Asimov's activation confirmation
shadow week:         DECLINED BY THE OWNER on 2026-10-16 ("no shadow period. ship it and make it work right away"), as relayed.
                     Not run, not met, no measurement. Never to be described as done.
faster check:        DECLINED BY THE OWNER on 2026-10-16 ("skip the check"), as relayed. Not run.
repository caution:  ACCEPTED BY THE OWNER on 2026-10-16 ("ignore and treat as normal"), as relayed; squash merge; one-sentence re-ask
                     at any push (the terms file holds the slur list and the whole vocabulary). Recommendation to keep it private stands.
decision record:     "confirmed" 2026-10-16 for the four questions and four answers ONLY; the later-decision quotations are re-asked at ON
block length:        ACCEPTED by the owner on 2026-10-16 ("accept it"): worst case 733 characters (6 lines); typical about 330; soft target
                     about 600 not met; nothing cut. Asked again only if a limit changes
state of the build:  built, OFF by default. Not shadow-tested. Not deployed. Not merged. Not pushed.
AI involvement:      NONE (Peter's decision; enforced by tests; independently re-checked four times)
legal review:        OVERRIDDEN BY OWNER, not reviewed by counsel (Mason skipped; Rule 6 attorney review overridden)
shadow length:       none run: the 7 days (Rule 6) were declined and the 30 or 90 days (Rule 7) were not applied
open legal items:    lawfulness and retention of pod-inbox / Missive copies: accepted by owner, not reviewed by counsel
word list:           wo-supp-v4: 1,511 terms (v1 911, v2 +213, v3 +331, v4 +56), 16 pair rules, additions only, 0 removed or changed
                     (checked by program against the real v1, v2 and v3 files); Peter has not yet seen the diff
audit row:           eleven keys plus trace; no category name anywhere (R3-1 met); one new constant cause value, link_shape
Missive exclusion:   Peter said yes ("yes stop copying them"); deployed ~15:10 local 2026-10-16 from commit 3f6922e; seen working on a real
                     alert (#161: not stored, copies still 153, two exclusion events), as relayed; must be confirmed again by hash and on the
                     first real alert after the description deploy (not an ancestor of this branch: file-scoped deploy, O-5)
TARS:                PASS on c781a1b (209 of 209; mutants all caught; off mode identical to the live code in 3,784 comparisons)
Sentinel:            no S1, no S2 open (S2-D closed); S3 residuals accepted by name; clear for deploy with the mode off and for ON on the code
Viper:               bypasses found, none critical or high; N1 (passive, person-first violence) accepted and named; tail from N3 unseen (O-8)
Ralph:               RESILIENT, no blockers (cron time limit is Scotty's)
Judge:               not received for c781a1b (O-1)
repository:          PUBLIC when last checked (2026-10-16); see "repository caution"
stop rule:           any report of text that should have been held: mode back to off the same day, extend the list,
                     clean up by hand, and switching back on needs Peter's fresh yes
```
