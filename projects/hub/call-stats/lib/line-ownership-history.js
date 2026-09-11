/**
 * line-ownership-history.js
 * Who actually worked each Aircall line, and from when.
 *
 * Author: Neo (database specialist), 2026-09-10
 * Approved by Peter 2026-09-10 (COMMITTED-NOT-BUILT.md §1c).
 *
 * ============================================================
 * IN ONE SENTENCE
 * ============================================================
 * For a handful of named lines, this file says "do not attribute unnamed
 * calls on this line before this date" — because the person who actually
 * worked that line back then is not the person the line rings today — and,
 * since 2026-09-11, may instead say "charge them to this person by name,"
 * which is legal only on a period that a later entry has already closed.
 *
 * ============================================================
 * WHY THIS IS A FILE AND NOT A DATABASE TABLE — the decision, made
 * explicitly so nobody has to re-litigate it
 * ============================================================
 * The obvious instinct is a `call_stats_line_ownership` table with
 * valid_from/valid_to. It was considered properly and rejected. The reason
 * is not "a file is easier"; it is that a table would be the wrong SHAPE for
 * what this data actually is.
 *
 * What this data is: an INPUT TO A WRITE, consumed at aggregation time and
 * then thrown away. Attribution in this schema is snapshotted onto each
 * `call_stats_line_misses` row (migration 20260910010000, Design Decision
 * 11) and never recomputed. So the moment the backfill finishes, the
 * correction this file describes is already recorded permanently, per row,
 * in the database. Nothing joins to this list at query time. Nothing on the
 * dashboard reads it. It is not a dimension; it is a rule applied once.
 *
 * A table would therefore hold a SECOND copy of a fact that is already
 * durable in the rows — the classic setup for the two copies disagreeing
 * later, which is the failure this project keeps hitting.
 *
 * Each option, with what actually breaks:
 *
 *   * A table with a hand-applied migration (REJECTED). Costs, all real in
 *     this project: Peter hand-pastes a migration into Supabase's SQL
 *     Editor; then the rows have to be SEEDED, which is either a second
 *     hand-paste of INSERT statements or a script — and the seed content is
 *     the same literal list that is below, just further from the code that
 *     reads it and invisible in a pull-request diff. Then an RLS policy, or
 *     the service-role key reads it and no human can. There is no UI and
 *     there is not going to be one, so "editable without a deploy" means
 *     "Peter writes SQL by hand," which is harder for him than asking for a
 *     one-line file change, not easier. And it buys nothing at read time,
 *     because there is no read at query time.
 *
 *   * A versioned membership table with valid_from/valid_to (REJECTED —
 *     again). Migration 20260910010000 already rejected exactly this shape
 *     for v1 and named the condition under which it would become right:
 *     "only if something else in the Hub ever needs 'who was on which line
 *     on date X' independently of a miss count." Nothing does. This request
 *     is not that condition arriving — it is the same single consumer
 *     needing one more input.
 *
 *   * A version-controlled data file (CHOSEN). It is reviewable in a diff
 *     with the reason sitting beside the date; `git log` answers "when did
 *     this change and who changed it" for free, which is precisely the
 *     provenance a table would need extra columns to fake; it needs no
 *     hand-applied migration, no seed step, no RLS policy; and it ships in
 *     the SAME deploy as Q's code change, which is happening anyway — so
 *     the "but a file needs a deploy" objection costs literally nothing
 *     here, because the consumer of the file is being deployed alongside it.
 *
 * The honest cost of this choice, stated rather than buried: a business fact
 * now lives in the repo, and changing it needs a deploy. That is acceptable
 * because the fact changes roughly twice a year, cannot be safely edited by
 * anyone who is not also looking at Aircall, and — as the entries below show
 * — takes archaeology against six months of raw call data to derive in the
 * first place. It is not operator-editable data. It is a finding.
 *
 * REVISIT THIS DECISION IF: something other than the sync needs to know who
 * held a line on a given date; or the dashboard needs to join to it live; or
 * this list grows past roughly a dozen entries; or Peter ever needs to
 * change it without an engineer in the room. Any one of those turns the
 * table into the right answer, and this file converts into its seed data.
 *
 * ============================================================
 * THE PROBLEM THIS FIXES — Aircall destroys attribution when a seat is
 * deleted
 * ============================================================
 * Aldo Hernandez left Rincon around 2026-08-27. `GET /v1/users/1906760` now
 * returns 404, and every call he ever handled comes back from Aircall with
 * its `user` field STRIPPED. His history did not disappear — it became
 * anonymous.
 *
 * `lib/sync.js`'s `buildLineMissAggregates()` charges an unnamed call to
 * whoever rings that line TODAY. So without this file the six-month backfill
 * would credit 1,257 of Aldo's calls to Leo O'Gorman — 363 answered, 683
 * outbound, 211 missed — moving Leo's answer rate from 75.9% to only 77.0%.
 * Nothing would have looked wrong in the meeting. That is the dangerous
 * part: the corruption is quiet.
 *
 * Migration 20260910010000 snapshots ring membership so a LINE CHANGING
 * HANDS cannot rewrite history. It does not guard A PERSON LEAVING, which
 * produces the same corruption by a different route. Peter's "no line
 * changed hands in six months" confirmation was true and simply did not
 * cover this case. This file covers it.
 *
 * ============================================================
 * HOW AN ENTRY IS READ — the exact algorithm, so the boundary can only be
 * implemented one way
 * ============================================================
 * Entries are grouped by `aircall_number_id` and sorted by `from` ascending.
 * For a given line and a given `call_date`:
 *
 *   1. If the line has NO entries at all — the normal case, and the case
 *      almost every line is in — behave exactly as today: attribute per the
 *      line's current Aircall ring membership. This file changes nothing for
 *      those lines.
 *   2. If `call_date` is EARLIER than the line's earliest `from`, attribute
 *      to NOBODY. The row is still written and stays visible.
 *   3. Otherwise the governing entry is the LAST one whose `from` is less
 *      than or equal to `call_date`. That entry's `attribute_to` decides.
 *
 * `from` is INCLUSIVE. It is a Pacific-time calendar date in `YYYY-MM-DD`
 * form, the same form `call_stats_line_misses.call_date` uses, and it must
 * be compared as a STRING (`entry.from <= callDate`). Lexicographic
 * comparison on zero-padded `YYYY-MM-DD` is exact. Do not parse either side
 * into a Date object — that is how a timezone bug gets introduced into a
 * boundary that has no time component at all.
 *
 * Periods are CONTIGUOUS by construction: an entry's period runs from its
 * `from` until the next entry's `from` (exclusive), and the last entry runs
 * to the present. There is deliberately no `until` field, so a gap or an
 * overlap cannot be expressed, and closing one period while opening the next
 * is a single edit rather than two that can disagree.
 *
 * ============================================================
 * THE FIELDS
 * ============================================================
 *   aircall_number_id  STRING. The key. Aircall's own numeric line ID as a
 *                      string, matching how `lib/sync.js` buckets rows and
 *                      what `call_stats_line_misses.aircall_number_id`
 *                      stores. Keyed on ID rather than name on purpose: this
 *                      is a statement about one specific physical line, and
 *                      it must keep applying if the line is renamed in
 *                      Aircall.
 *
 *   line_name          STRING. For humans reading this file and for log
 *                      messages. NEVER used for matching. Q cross-checks it
 *                      against Aircall's current name for that ID and LOGS
 *                      LOUDLY on a mismatch — a renamed line may simply have
 *                      been renamed, or may have been repurposed entirely,
 *                      which is itself an ownership event somebody needs to
 *                      look at.
 *
 *   from               STRING, `YYYY-MM-DD`, INCLUSIVE. See the algorithm
 *                      above.
 *
 *   attribute_to       Decides who a call in this period is charged to.
 *                      THREE values are legal, as of 2026-09-11:
 *
 *                        'ring_membership' — attribute per the line's
 *                          CURRENT Aircall ring membership, i.e. the normal
 *                          existing behaviour. This is what the newest
 *                          period on a corrected line says, and it is why
 *                          this file never duplicates a live fact: for the
 *                          period that is still running, Aircall stays the
 *                          source of truth and this file stays silent about
 *                          who that is.
 *
 *                        null — attribute to NOBODY. The calls stay visible
 *                          and are charged to no individual. Nothing is
 *                          deleted, ever.
 *
 *                        AN EMAIL STRING — ENABLED 2026-09-11 BY PETER, AND
 *                          LEGAL ONLY ON A CLOSED PERIOD. It means "charge
 *                          this period to this person even though they no
 *                          longer ring the line." This was a documented
 *                          future extension point until Peter's decision of
 *                          2026-09-11; it is now live, for the reason the
 *                          848524 entry below records at length — `null`
 *                          withholds attribution rather than redirecting it,
 *                          which handed Leo O'Gorman a flattering 99.8% in
 *                          place of his real 76.5%, and a wrong number that
 *                          flatters is worse than one that damages because
 *                          nobody questions it.
 *
 *                          *** A PERIOD IS CLOSED WHEN A LATER ENTRY EXISTS
 *                          FOR THE SAME LINE. AN EMAIL ON THE NEWEST ENTRY
 *                          FOR A LINE IS REJECTED BY THE LOADER, WHICH THROWS
 *                          AT LOAD AND STOPS THE HUB FROM STARTING. *** That
 *                          restriction is the whole safety property of this
 *                          change and it is ENFORCED, not merely documented.
 *                          The reason: a running period must always say
 *                          'ring_membership' so this file can never hold a
 *                          second, divergent copy of who rings a line today.
 *                          An email there would hardcode today's holder, and
 *                          the day the line changes hands the file would keep
 *                          charging the wrong person with nothing failing and
 *                          nobody told — the exact stale-configuration
 *                          failure this project has now hit three times. A
 *                          CLOSED period is safe precisely because it
 *                          describes a finished, measurable past that cannot
 *                          change again.
 *
 *                          The email must be lower-case, well-formed, and
 *                          must MATCH A ROW IN `users` — checked at
 *                          aggregation time, where the staff list is in hand,
 *                          and throwing if it does not. It is NOT required to
 *                          be `is_active`: naming a departed person's history
 *                          is the main thing this value is for (Aldo
 *                          Hernandez is `is_active: false`), and `is_active`
 *                          decides whether somebody is RENDERED on today's
 *                          scorecard, not whose work six months of calls
 *                          were. See crossCheckLineOwnershipNamedEmails() in
 *                          lib/sync.js for the full argument and for what
 *                          naming an inactive person looks like on the page.
 *
 *                      Q's loader REJECTS any other value loudly — never
 *                      silently treat an unrecognised value as null, which
 *                      would quietly uncharge somebody, and never treat
 *                      anything containing an "@" as an email: a malformed or
 *                      unresolvable address produces a row that is stamped,
 *                      constraint-legal, and then dropped to unattributed,
 *                      which looks exactly like the `null` behaviour it was
 *                      meant to replace and reports nothing.
 *
 *   worked_by          STRING. Who actually worked the line in this period,
 *                      in plain English. DOCUMENTATION ONLY — it is never
 *                      joined, never matched, never used to attribute
 *                      anything. It exists so the next reader knows what
 *                      the period means, and so the backfill report and the
 *                      dashboard can say "Apr–Aug 2026: Aldo Hernandez
 *                      (departed), charged to nobody" instead of the
 *                      useless "unattributed."
 *
 *   reason             STRING. Why this entry exists. MANDATORY, AND THE
 *                      POINT OF THE WHOLE FILE. An entry with a date and no
 *                      reason gets deleted in six months by someone who
 *                      assumes it is stale — that is the third-time-this-has
 *                      -happened failure mode this file was written to stop.
 *                      Every entry must survive the question "why is this
 *                      still here?" on its own text.
 *
 *   recorded_on        STRING, `YYYY-MM-DD`. When the entry was added.
 *   recorded_by        STRING. Who established the fact and how it was
 *                      verified. Not a signature — a pointer to the
 *                      evidence, so a future reader can re-check the claim
 *                      instead of re-deriving it from scratch.
 *
 * ============================================================
 * ADDING THE NEXT ONE — this is meant to be one line
 * ============================================================
 * When somebody leaves or a line changes hands, append one object. Close the
 * old period and open the new one by adding an entry whose `from` is the
 * first day of the new arrangement; the previous period ends automatically.
 * Do not edit an existing entry's `from` or `attribute_to` — an existing
 * entry is a historical record, and rewriting it changes numbers Peter has
 * already read out in a meeting.
 *
 * THAT RULE WAS BROKEN ONCE, ON 2026-09-11, DELIBERATELY AND BY PETER, and
 * the exception is worth stating so the next person does not read the
 * precedent as permission. The 848524 closed period's `attribute_to` was
 * changed from `null` to `leo@rinconmanagement.com`. What made it legitimate:
 * the entry was ONE DAY OLD, its own text already said `null` was an
 * unfinished answer and named the decision it was waiting on, the numbers it
 * produced had been read by nobody in a meeting, and Peter made the policy
 * call himself. None of that generalises. An entry that has survived a
 * reporting cycle is a historical record again, and the way to change what it
 * says is a new period, not an edit.
 *
 * ============================================================
 * NO LONGER PENDING — Regina Franco Mendez, and the ONE DAY between
 * "agreed" and "done" that is the real lesson of this file
 * ============================================================
 * On 2026-09-10 this section said, correctly, that Regina was still in
 * training, that Aircall still rang Leo O'Gorman on "Maintenance
 * Coordinator-Solimar," and that no entry would be added for a handover that
 * had not happened. The comment at the foot of the list went further and said
 * the line needed no cutoff AT ALL, because Leo "owns past and present." Both
 * statements were true when written. BOTH WERE FALSE THE NEXT MORNING: the
 * handover was executed on 2026-09-11 and the line now rings Regina.
 *
 * The two entries for line 848524 at the bottom of the list are the
 * correction, and their `reason` fields carry what the one-day-stale belief
 * actually cost. What a future reader should take from them is not the dates.
 * It is that "no cutoff needed, this person owns past and present" is a claim
 * with a SHELF LIFE, and this one lasted less than twenty-four hours. A line
 * with no entry is still the normal case — but "no entry needed" has to be
 * re-derived from Aircall on the day a backfill actually runs, and must never
 * be inherited from a comment written on an earlier day, however carefully
 * that comment was reasoned.
 *
 * AND THE SAME THING HAPPENED TWICE, IN THE SAME SECTION. This section also
 * predicted on 2026-09-10 that Regina, being `regina@quickturnmaintenance.com`
 * on an external vendor domain, would have NO ROW IN `users`, so her misses
 * would be "tracked and charged to nobody." MEASURED 2026-09-11: SHE HAS A
 * `users` ROW. Her misses are charged TO HER, and that is why the mis-attributed
 * six months showed up as a visible 51.4% against her name instead of quietly
 * vanishing into unattributed rows. Do not carry the old claim forward — it is
 * the second belief in this one section to expire inside a day.
 *
 * Two things follow, and only one of them has been decided. (1) Her real work
 * on her OWN line, "Quick Turn Admin Assistant" (855897), does count and always
 * did; that line has no entry in this file and none of this touches it. (2)
 * Whether an outside vendor belongs on an internal staff performance dashboard
 * at all is STILL Peter's decision and still has not been made — a `users` row
 * appearing is not that decision being made, it is just a row. Do not make it
 * here.
 *
 * ============================================================
 * GOVERNANCE (GOVERNANCE.md Rule 4)
 * ============================================================
 * No schema change, so no Data Inventory entry changes and no migration is
 * required. This file introduces no new category of personal data: it holds
 * Rincon employee names, which already appear throughout these migrations,
 * specs and the `users` table. No tenant, applicant or owner data. No
 * housing decision. Not a compliance build under CLAUDE.md's definition — no
 * Asimov gate, no Mason gate, same conclusion the three sibling migrations
 * reached for the same reasons.
 *
 * One deliberate wording choice: the entry naming a departed employee below
 * records only that he left and that Aircall deleted his seat. It carries no
 * characterisation of his work, and none should ever be added here. This is
 * a phone-system fact, not a personnel file.
 */

const LINE_OWNERSHIP_HISTORY = Object.freeze([

  // ── Office Line ──────────────────────────────────────────────────────
  Object.freeze({
    aircall_number_id: '848521',
    line_name: 'Office Line',
    from: '2026-05-01',
    attribute_to: 'ring_membership',
    worked_by: 'Kristen Rau',
    reason:
      'Before May 2026 this line was an office phone tree exclusively — no individual ' +
      'was behind it. Measured against six months of raw Aircall calls on 2026-09-10: ' +
      '365 unnamed outbound calls in Mar–Apr 2026, then zero. Kristen moved into ' +
      'Business Development Coordinator in Mar/Apr and the line became hers from May. ' +
      'Aircall rings Kristen on it TODAY, so without this cutoff the backfill would ' +
      'charge the phone tree\'s Mar–Apr calls to her personally. Nothing before ' +
      '2026-05-01 belongs to any individual.',
    recorded_on: '2026-09-10',
    recorded_by:
      'Neo — derived from a six-month raw-call measurement reported 2026-09-10 and ' +
      'confirmed by Peter (COMMITTED-NOT-BUILT.md §1c).',
  }),

  // ── RSC Solimar Team ─────────────────────────────────────────────────
  //
  // This line needs TWO entries, and the first one is why this file has an
  // `attribute_to: null` case at all. The Apr–Aug period names a person
  // whose Aircall seat has been deleted: that fact is recoverable from NO
  // system any more, which is exactly why it is written down here rather
  // than left as "before the earliest entry." Contrast the Office Line
  // above, whose excluded era was a phone tree — no person to name, and the
  // 05-01 entry's own `reason` already says so, so it needs no second entry.
  Object.freeze({
    aircall_number_id: '848525',
    line_name: 'RSC Solimar Team',
    from: '2026-04-01',
    attribute_to: null,
    worked_by: 'Aldo Hernandez (Aircall user 1906760 — seat deleted, GET /v1/users/1906760 returns 404)',
    reason:
      'Aldo worked this line from Apr 2026 until he left Rincon around 2026-08-27. ' +
      'When Aircall deleted his seat it STRIPPED the `user` field from every call he ' +
      'ever handled — 1,257 of them on this line: 363 answered, 683 outbound, 211 ' +
      'missed. Those calls are now anonymous, so `buildLineMissAggregates()` would ' +
      'charge them to whoever rings the line today. They are charged to NOBODY ' +
      'instead. They remain fully visible in the Shared Line Misses section; nothing ' +
      'is deleted. NOTE THE MONTH BOUNDARY: Aldo left ~2026-08-27 but this period runs ' +
      'to 2026-08-31, so 08-28..08-31 is charged to nobody rather than to Leo. That is ' +
      'deliberately conservative — under-charging beats charging Leo for a departed ' +
      'colleague\'s stripped calls — and it touches only the three days of 08-29..08-31 ' +
      'that this table currently holds.',
    recorded_on: '2026-09-10',
    recorded_by:
      'Neo — derived from a six-month raw-call measurement reported 2026-09-10 and ' +
      'confirmed by Peter (COMMITTED-NOT-BUILT.md §1c). Month granularity is Peter\'s ' +
      'confirmation, not a measured changeover date.',
  }),

  Object.freeze({
    aircall_number_id: '848525',
    line_name: 'RSC Solimar Team',
    from: '2026-09-01',
    attribute_to: 'ring_membership',
    worked_by: 'Leo O\'Gorman',
    reason:
      'Leo moved into Aldo\'s role on his departure and this line has been his from ' +
      'Sep 2026. From this date forward the normal rule applies again and Aircall\'s ' +
      'current ring membership is the source of truth — which is why this entry names ' +
      'no email: the live mapping already knows. ' +
      'THE PRE-APRIL ERA, AND WHY THE 2026-04-01 ENTRY ABOVE IS LOAD-BEARING: before ' +
      'Mar 2026 this line was Kristen Rau\'s. Her NAMED calls are correctly attributed ' +
      'on Aircall\'s own records (she is still employed), so those land in `call_stats` ' +
      'under her and never reach this table — 58 of them over 2026-03-10..31. But the ' +
      'named calls are not all of the calls. In that SAME window, 47 USER-LESS inbound ' +
      'misses on this line DO reach `call_stats_line_misses`, and they are charged to ' +
      'nobody for one reason only: 2026-04-01 is this line\'s EARLIEST `from`, and rule ' +
      '2 of the algorithm in this file\'s header charges everything before a line\'s ' +
      'earliest entry to nobody. Six of those 47 are `agents_did_not_answer`. So if a ' +
      'future reader concludes from "Kristen\'s calls are named" that the pre-April era ' +
      'needs no coverage and moves that earliest `from` back to March with ' +
      '\'ring_membership\', all 47 become attributed to Leo and six of them land on his ' +
      'Answer Rate as misses he was not there for. DO NOT MOVE IT. An earlier version ' +
      'of this sentence claimed Kristen\'s pre-March calls "never reach this table at ' +
      'all" and that no entry was needed for that era — true of her named calls, false ' +
      'of the line, and it argued for exactly the edit that breaks this. Corrected ' +
      '2026-09-10.',
    recorded_on: '2026-09-10',
    recorded_by:
      'Neo — derived from a six-month raw-call measurement reported 2026-09-10 and ' +
      'confirmed by Peter (COMMITTED-NOT-BUILT.md §1c). The pre-April figures in the ' +
      'reason above (58 named calls in `call_stats`, 47 user-less inbound misses in ' +
      '`call_stats_line_misses`, 6 of them `agents_did_not_answer`) are TARS\'s direct ' +
      'measurement of line 848525 over 2026-03-10..31, taken 2026-09-10 — re-checkable ' +
      'against Aircall for that window rather than re-derived.',
  }),

  // ── Maintenance Coordinator-Solimar ──────────────────────────────────
  //
  // THIS IS THE LINE THAT WAS "DELIBERATELY ABSENT" UNTIL 2026-09-11. The
  // comment that used to sit here said Leo O'Gorman owned it past and present
  // and that it therefore needed no cutoff. That was accurate on 2026-09-10
  // and wrong on 2026-09-11. It is replaced by the two entries below rather
  // than left standing beside them, because a comment saying "this line has no
  // entry" sitting next to two entries is worse than no comment at all.
  //
  // The FIRST entry NAMES LEO O'GORMAN, and that is the only one of the three
  // legal values that is correct here — see its reason. It cannot say
  // 'ring_membership', because that means "whoever rings this line TODAY" and
  // today that is Regina. It said `null` for one day, until Peter enabled
  // naming on 2026-09-11; `null` withheld the attribution instead of
  // redirecting it and handed Leo a flattering 99.8%.
  Object.freeze({
    aircall_number_id: '848524',
    line_name: 'Maintenance Coordinator-Solimar',
    from: '2026-03-10',
    attribute_to: 'leo@rinconmanagement.com',
    worked_by: 'Leo O\'Gorman (still employed — his NAMED calls on this line are correctly attributed to him on Aircall\'s own records and never reach this table; the USER-LESS ones, which do reach it, are charged back to him by name by this entry)',
    reason:
      'THE HANDOVER: Regina Franco Mendez taking over this line was AGREED on 2026-09-10 ' +
      'and EXECUTED on 2026-09-11. Aircall rings Regina on it from 2026-09-11; it rang Leo ' +
      'before that. ' +
      'THE MEASURED BOUNDARY, not an assumed one — real Aircall calls on line 848524: ' +
      '2026-09-09, Leo, 4 calls, his last activity on the line; 2026-09-10, NO CALLS AT ALL ' +
      'on the line; 2026-09-11, Regina, 3 outbound, all answered, her first activity on it ' +
      'ever. A clean break with no overlapping day. Cached history confirms Leo held it ' +
      'continuously from 2026-03-10 (3,039 calls) and that Regina had ZERO calls on it ' +
      'before 2026-09-11. So: Leo through 2026-09-10 inclusive, Regina from 2026-09-11. ' +
      'WHY THIS PERIOD NAMES LEO RATHER THAN SAYING \'ring_membership\': \'ring_membership\' ' +
      'means "attribute per the line\'s CURRENT Aircall ring membership," and the current ' +
      'ringer is Regina — so \'ring_membership\' on this closed period would hand six months ' +
      'of Leo\'s line straight back to her, which is the exact bug this entry exists to undo. ' +
      'AND WHY IT NO LONGER SAYS null — THE 2026-09-11 POLICY CALL, WHICH IS PETER\'S AND NOT ' +
      'THIS FILE\'S: for one day this entry read `attribute_to: null`, because naming a person ' +
      'was a documented extension point the loader deliberately rejected. That entry\'s own ' +
      'text said plainly that it did not finish the job, and named the decision it was ' +
      'waiting on. Peter made that decision on 2026-09-11 and enabled naming, FOR THIS CASE. ' +
      'WHY null WAS INSUFFICIENT, IN THE NUMBERS THAT MADE THE ARGUMENT: `null` withholds ' +
      'attribution rather than redirecting it, so Leo\'s 257 user-less shared-line misses went ' +
      'to nobody and he read 839 answered / 2 missed / 99.8% — against a true 843 / 259 / ' +
      '76.5%. It replaced a damaging wrong number with a FLATTERING wrong number, which is ' +
      'worse, because nobody questions a good figure in a staff meeting. Under-charging is the ' +
      'conservative answer when the alternative is charging the WRONG named person (which is ' +
      'why the Aldo Hernandez period one entry up still says null — his calls are anonymous ' +
      'and no measurement can say which were his); it is not the conservative answer when the ' +
      'right person is known, measured, and still employed. ' +
      'WHAT NAMING DOES TO THE ROWS: only USER-LESS calls on this line reach ' +
      '`call_stats_line_misses` at all. Leo is still employed, so his own named calls are ' +
      'unaffected and stay in `call_stats` under his name. The user-less ones are stamped ' +
      'sole_user_email = leo@rinconmanagement.com with ring_user_count = 1, which makes them ' +
      'attributable by the ordinary path — no new row shape, no consumer needing to know the ' +
      'name came from a file. They stay fully visible and fully measured in Shared Line ' +
      'Misses; nothing is deleted. ' +
      'NAMING STAYS ILLEGAL ON A RUNNING PERIOD, AND THAT IS NOT A DETAIL — IT IS THE WHOLE ' +
      'SAFETY PROPERTY OF THE CHANGE. This period is safe to name because a later entry ' +
      '(2026-09-11, Regina) has CLOSED it: it describes a finished, measurable past that ' +
      'cannot change again. The period that is still running must always say ' +
      '\'ring_membership\', so this file can never hold a second, divergent copy of Aircall\'s ' +
      'live configuration — an email there would hardcode today\'s holder and keep charging ' +
      'them after the next handover, silently, which is the stale-configuration failure this ' +
      'project has hit three times. The loader ENFORCES it: an email on the newest entry for a ' +
      'line throws at load and the Hub refuses to start. Do not weaken that to a convention. ' +
      'THE DAMAGE THIS UNDOES, measured 2026-09-11: a backfill re-run that day stamped ' +
      'TODAY\'s ring membership across all 184 days. Leo went from 843 answered / 259 missed ' +
      '/ 76.5% to 839 / 2 / 99.8%; Regina went from 0 / 29 / 0% to 303 / 286 / 51.4%. Six ' +
      'months of Leo\'s work was charged to Regina and both numbers were wrong. ' +
      'AND THE PART THE NEXT READER ACTUALLY NEEDS: this line was DELIBERATELY LEFT OUT of ' +
      'the original ownership history on 2026-09-10, on the reasonable and correctly-recorded ' +
      'belief that Leo "owns past and present — no cutoff needed." That belief was true when ' +
      'written and EXPIRED WITHIN ONE DAY. The failure mode here is not a missing date; it is ' +
      'trusting a "no entry needed" conclusion that was derived on an earlier day. Re-derive ' +
      'it from Aircall on the day the backfill runs.',
    recorded_on: '2026-09-11',
    recorded_by:
      'THE `attribute_to` VALUE IS PETER\'S, 2026-09-11 — the policy call this entry\'s own ' +
      'earlier text reserved for him, made the same day the entry was written. It changed from ' +
      '`null` to \'leo@rinconmanagement.com\'; `null` produced a flattering 99.8% in place of ' +
      'Leo\'s real 76.5%. It is an EDIT to an existing entry, which this file\'s ADDING THE ' +
      'NEXT ONE section otherwise forbids — see that section for why this single case was ' +
      'legitimate (the entry was one day old, its numbers had been read by nobody, and it said ' +
      'itself that it was waiting on exactly this decision) and why it does not generalise. ' +
      'THE DATES AND VOLUMES BELOW ARE UNCHANGED AND ARE Q\'S: direct Aircall measurement of ' +
      'line 848524 taken 2026-09-11 — per-day call listing ' +
      'across 2026-09-09..09-11 (Leo 4 calls on 09-09, zero calls on 09-10, Regina 3 answered ' +
      'outbound on 09-11) plus the cached six-month history for the line (Leo 3,039 calls from ' +
      '2026-03-10, Regina 0 before 09-11), and Aircall\'s live ring membership for 848524 ' +
      'naming Regina. Re-checkable against Aircall for those dates rather than re-derived. ' +
      'The 2026-09-10 handover agreement is Peter\'s own confirmation ' +
      '(COMMITTED-NOT-BUILT.md §1c, "Pending, add when it happens").',
  }),

  Object.freeze({
    aircall_number_id: '848524',
    line_name: 'Maintenance Coordinator-Solimar',
    from: '2026-09-11',
    attribute_to: 'ring_membership',
    worked_by: 'Regina Franco Mendez (Quick Turn Maintenance — regina@quickturnmaintenance.com, an external vendor who DOES have a row in `users`, measured 2026-09-11)',
    reason:
      'The handover was executed on 2026-09-11 and Aircall rings Regina on this line from ' +
      'that date. From here the normal rule applies again and Aircall\'s current ring ' +
      'membership is the source of truth — which is why this entry names no email: the live ' +
      'mapping already knows, and the running period must always say \'ring_membership\' so ' +
      'this file can never drift out of step with Aircall\'s live configuration. ' +
      'FIRST ACTIVITY MEASURED, NOT ASSUMED: 3 outbound calls, all answered, on 2026-09-11, ' +
      'her first ever on this line. Leo\'s last was 4 calls on 2026-09-09; 2026-09-10 had no ' +
      'calls on the line at all, so the break is clean and this `from` cannot be off by a day ' +
      'in either direction. ' +
      'HER MISSES HERE DO LAND ON HER, AND THE 2026-09-10 HEADER PREDICTED THE OPPOSITE. ' +
      'That header said Regina, being on an external vendor domain, would have no row in ' +
      '`users`, so `isAttributableLineMissRow()` would drop her misses to unattributed. ' +
      'MEASURED 2026-09-11: `regina@quickturnmaintenance.com` IS in `users`, so this line\'s ' +
      'misses are charged to her by name from this date on. That is what made the bad re-run ' +
      'visible — six months of Leo\'s line showed up as a 51.4% against HER name rather than ' +
      'disappearing quietly into unattributed rows. Whether an outside vendor belongs on an ' +
      'internal staff performance dashboard at all remains Peter\'s decision and has not been ' +
      'made; a `users` row existing is not that decision. ' +
      'DOES NOT TOUCH HER OWN LINE: Regina\'s real work on "Quick Turn Admin Assistant" ' +
      '(855897) is a different line with no entry in this file and is attributed exactly as ' +
      'it always was.',
    recorded_on: '2026-09-11',
    recorded_by:
      'Q — same 2026-09-11 Aircall measurement as the entry above (per-day call listing for ' +
      'line 848524 over 2026-09-09..09-11, plus live ring membership for 848524 naming ' +
      'Regina). The handover agreement itself is Peter\'s confirmation of 2026-09-10 ' +
      '(COMMITTED-NOT-BUILT.md §1c).',
  }),

  // Every other Rincon line is absent from this list, and an absent line is
  // the NORMAL case, not an oversight — rule 1 of the algorithm attributes it
  // per current ring membership, exactly as before this file existed. But see
  // the header: absence is a claim about TODAY, and the entries above are what
  // a one-day-old absence claim cost.

]);

module.exports = { LINE_OWNERSHIP_HISTORY };


/*
 * ============================================================
 * NOTES FOR Q — read before wiring this in
 * ============================================================
 *
 * 1. APPLY IT INSIDE `buildLineMissAggregates()`, NOT IN THE BACKFILL.
 *    `lib/sync.js` and `backfill-six-months.js` both call that one function,
 *    so putting the rule there gets the nightly sync, the `?date=` re-run
 *    path and the six-month backfill all at once. Require this module
 *    directly the way `lib/sync.js` already requires `./timezone` — no new
 *    argument, so `backfill-six-months.js` needs NO code change at all
 *    (only its header corrected, see note 8). Putting the rule in the
 *    backfill instead would leave the `?date=` re-run hazard that migration
 *    20260910010000 warns about wide open: re-running a single day in April
 *    would re-stamp today's mapping and quietly re-credit Aldo's calls to
 *    Leo, one day at a time.
 *
 * 2. AN EXCLUDED ROW WRITES BOTH ATTRIBUTION COLUMNS NULL —
 *    `sole_user_email = NULL` AND `ring_user_count = NULL`.
 *    This is not a new state. It is the state `lib/sync.js` already writes
 *    on its `lines_missing_from_mapping` branch, and it means exactly the
 *    right thing here: "this run does not know who this line rang on that
 *    date." Check it against the table's constraints — it passes all three,
 *    and every existing consumer already does the right thing with it:
 *      - `call_stats_line_misses_sole_user_requires_one_ringer` is satisfied
 *        (sole_user_email IS NULL).
 *      - `router.js`'s `isAttributableLineMissRow()` requires
 *        `ring_user_count === 1`, so the row falls through to unattributed
 *        and stays visible in Shared Line Misses. Nothing goes missing.
 *      - the data-quality alarm `rows_sole_user_email_unresolved` fires only
 *        on `ring_user_count === 1` with no email, so it does NOT fire here.
 *        That matters: these rows are a deliberate, correct exclusion, not a
 *        failure, and they must not drown the real alarm in noise.
 *
 *    Do NOT write `ring_user_count` as the line's real current count with a
 *    NULL email — that trips the alarm on every excluded row and, worse,
 *    asserts a membership fact about a date this system cannot know.
 *
 *    A NAMED ROW IS THE OPPOSITE CASE AND WRITES BOTH COLUMNS (added
 *    2026-09-11): `sole_user_email` = the named email, `ring_user_count` = 1.
 *    That satisfies the same constraint from the other side
 *    (`sole_user_email IS NULL OR ring_user_count = 1`), passes
 *    `isAttributableLineMissRow()` like any ordinary sole-user row, and does
 *    NOT trip `rows_sole_user_email_unresolved`, which fires only on
 *    `ring_user_count === 1` with NO email. The 1 there is a claim about
 *    ATTRIBUTION, not a measurement of that day's ring membership — the whole
 *    point of a named period is that Peter decided, with evidence, whose the
 *    calls were. Excluded rows still refuse to write a count, for the reason
 *    directly above; the two branches differ because one asserts something
 *    and the other refuses to.
 *
 * 3. THE EXCLUSION BRANCH COMES FIRST, AND GETS ITS OWN COUNTER. Test the
 *    ownership history BEFORE the `if (!membership)` missing-mapping branch,
 *    and count these rows in a new summary field of their own — something
 *    like `rows_excluded_by_line_ownership_history`, carrying the line name
 *    and the governing entry's `worked_by`. It must not increment
 *    `rows_line_missing_from_mapping` or any alarm counter. The backfill
 *    report should print the count and the governing entries, so Peter can
 *    see on the dry run that 1,257 of Aldo's calls were held back.
 *
 * 4. THE REASON AND VOICEMAIL COLUMNS ARE STILL WRITTEN, FULLY. The
 *    exclusion is about ATTRIBUTION only. `missed_calls`, `total_calls`,
 *    `missed_calls_agents_did_not_answer`, `missed_calls_by_reason` and
 *    `voicemails_left` are facts about the calls and must still be measured
 *    and stored on an excluded row. Writing them NULL would mean "no sync
 *    ever looked," which is false and would make the row unmeasured on the
 *    dashboard forever (see migration 20260910020000's NULL-means-not-
 *    captured section). Excluded rows are MEASURED and UNATTRIBUTED. Those
 *    are different things.
 *
 * 5. VALIDATE THIS FILE AT LOAD AND FAIL LOUD. A typo in an
 *    `aircall_number_id` is the whole failure mode this file exists to
 *    prevent, and it would otherwise be silent — the entry simply never
 *    matches, and Leo gets charged again with nothing anywhere saying so.
 *    At minimum, on load:
 *      - every `from` matches `^\d{4}-\d{2}-\d{2}$` and is a real calendar
 *        date;
 *      - `attribute_to` is `'ring_membership'`, `null`, or a well-formed
 *        lower-case email — anything else THROWS. AN EMAIL ON THE NEWEST
 *        ENTRY FOR A LINE ALSO THROWS: naming is legal only on a CLOSED
 *        period (updated 2026-09-11 — see THE FIELDS above; this rule
 *        previously rejected every email and no longer does);
 *      - every named email resolves to a row in `users`. That half cannot run
 *        at load — this module has no database — so it runs at aggregation
 *        time, before any row is built, and throws the same way. A name that
 *        cannot resolve must never reach a row: it would be stamped, pass the
 *        table's CHECK, and then be silently dropped to unattributed;
 *      - `reason` and `worked_by` are non-empty strings;
 *      - no two entries share the same (`aircall_number_id`, `from`);
 *      - and, once the live mapping is in hand, EVERY `aircall_number_id` in
 *        this file exists in Aircall's line list — a line ID here that
 *        Aircall does not know about is an error worth stopping for, not a
 *        warning. Cross-check `line_name` against Aircall's current name for
 *        that ID and log loudly on a mismatch (note 2 in the field docs).
 *
 * 6. ONE-LINE RULE, DO NOT GENERALISE IT — AND IT IS NOW ENFORCED IN CODE.
 *    The list only ever says "not the current ringer" about CLOSED historical
 *    periods. The period that is still running always says
 *    `'ring_membership'`, so this file can never drift out of step with
 *    Aircall's live configuration. If you find yourself wanting to hardcode a
 *    current holder's email here, stop — that is the stale-configuration
 *    failure this project has now hit three times, and it is what
 *    `attribute_to: 'ring_membership'` exists to prevent.
 *
 *    This was a convention until 2026-09-11 and is now a LOADER CHECK: since
 *    an email became legal on a closed period, the convention became the only
 *    thing standing between naming and exactly that failure, and a convention
 *    is not strong enough to be the only thing. The loader rejects an email
 *    on the newest entry for a line and refuses to start.
 *
 * 7. `worked_by` IS NOT A JOIN KEY. It is a human string. Do not parse it,
 *    match it against `users`, or derive an email from it.
 *
 * 8. CORRECT `backfill-six-months.js`'s HEADER — IT STATES SOMETHING FALSE,
 *    AND IT IS THE PREMISE THE WHOLE RETROACTIVE-STAMPING ARGUMENT RESTS ON.
 *    Under "WHAT IT STAMPS ON A HISTORICAL ROW," the "IMMUTABLE HISTORICAL
 *    FACT" paragraph currently claims:
 *
 *      "Aircall's record of a call that happened in April does not change.
 *       These are as good as a row the nightly sync wrote that night."
 *
 *    It is not true, and this file is the proof. Aircall MUTATES historical
 *    call records: deleting a user's seat strips the `user` field from every
 *    call that person ever handled. Verified 2026-09-10 —
 *    `GET /v1/users/1906760` returns 404 and all 1,257 of Aldo Hernandez's
 *    calls now come back with `user: null`.
 *
 *    The consequence is bigger than attribution, which is why the correction
 *    matters rather than being pedantry. `buildDailyAggregates()` SKIPS
 *    user-less calls. So a call that the nightly sync would have written to
 *    `call_stats` under Aldo's name in April is today written to
 *    `call_stats_line_misses` as a line-level, user-less call instead. The
 *    backfill does not reproduce what the nightly sync would have written —
 *    it produces a different row, in a different table, for any line worked
 *    by anyone who has since left. RSC Solimar's Apr–Aug line rows will
 *    carry roughly 1,046 answered and outbound calls in `total_calls` that
 *    were never user-less at the time.
 *
 *    Suggested replacement for that paragraph — the split it draws is real,
 *    the line is just drawn in the wrong place:
 *
 *      STABLE PER-CALL FIELDS — what is read off a single call object:
 *      duration, answered_at, missed_call_reason, voicemail. These do appear
 *      not to change after the fact.
 *
 *      NOT IMMUTABLE, AND THIS IS THE TRAP — WHICH CALLS ARE ON THE ROW AT
 *      ALL. Aircall rewrites history when a seat is deleted: it strips the
 *      `user` field from every call that person handled (verified
 *      2026-09-10 — GET /v1/users/1906760 returns 404 and all 1,257 of Aldo
 *      Hernandez's calls now return user: null). Because
 *      buildDailyAggregates() skips user-less calls and
 *      buildLineMissAggregates() claims them, a departure MOVES a person's
 *      historical calls out of call_stats and into
 *      call_stats_line_misses. A backfilled row is therefore NOT "as good as
 *      a row the nightly sync wrote that night" for any line worked by
 *      someone who has since left — the counts themselves differ, and the
 *      difference grows with every departure. lib/line-ownership-history.js
 *      is what stops those relocated calls being charged to whoever holds
 *      the line today; it cannot put them back in call_stats, and nothing
 *      can.
 *
 *      TODAY'S ANSWER, APPLIED RETROACTIVELY — sole_user_email and
 *      ring_user_count. (unchanged — that paragraph is correct as written.)
 *
 *    Also worth adding to the report, for Tron as much as for Peter: after
 *    the backfill, RSC Solimar's shared-line call VOLUME will appear to jump
 *    across the Aug/Sep boundary. That is an artefact of Aldo's departure
 *    moving his calls into this table, not a change in how much anyone used
 *    the phone.
 *
 *    Q owns that file. Neo has not edited it.
 */
