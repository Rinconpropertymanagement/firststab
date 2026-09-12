/**
 * lib/sales-classification-config.js
 * The two lists that decide what counts as a sales call, plus the
 * conversation threshold, in one place.
 *
 * SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md Design Decision 17 requires
 * these be configuration rather than literals at a call site, and requires
 * that a change be DATED — because classifications are snapshotted
 * (Design Decision 22), changing a list does not rewrite history. It means
 * days before the change were classified under one definition and days
 * after under another, and a date range spanning the change is mixing two
 * definitions. Same hazard as the answer-rate changeover date. Every edit
 * to the lists below gets a dated line in CHANGE LOG at the bottom.
 *
 * A `call_stats_sales_criteria` config table was considered and rejected
 * for v1, on TREND-VIEW-SPEC.md Design Decision 4's reasoning: a config
 * table needs an editing screen, and an editing screen needs a decision
 * about who may change what a company metric means. Nobody has asked to
 * edit this.
 */

// ============================================================
// LIFECYCLE STAGES THAT COUNT AS A PROSPECT
// ============================================================
// The rule these serve (Design Decision 17): a call is SALES only when a
// HUMAN at Rincon did something deliberate with the number. The Aircall
// integration sets neither a stage above the default nor a deal, so the
// ~1,275 exhaust contacts match nothing here — the design is indifferent
// to the 93% pollution rather than merely tolerant of it.
//
// LIVE-VERIFIED 2026-09-12 against Rincon's real portal: this account has
// SIXTEEN lifecycle options, not the 21 the spec asserted, and exactly
// THREE carry a "DO NOT USE" label (subscriber, lead, 183947028 Realtor
// Referral) — not nine. The spec's figures were stale; the list below is
// built from what the portal actually returns today, not from the spec.
//
// Deliberately EXCLUDED, and each for a reason rather than by omission:
//   2263812856  Contact      - the default. Every exhaust contact sits here.
//   customer                 - already signed. A call to a current client is
//                              operational work, not a sales call.
//   2751739581  No Deal      - a decided negative.
//   222271784   Unqualified  - a decided negative.
//   4294857428  SMS Inbox    - a channel marker, not a sales judgment.
//   other / 2688778999       - explicitly "not a lead."
//   subscriber / lead / 183947028 - the three "DO NOT USE" options. A
//                              contact sitting on one of these is carrying
//                              a stage nobody is supposed to set, so it is
//                              not evidence a human made a sales judgment.
//                              Live check: `lead` and `subscriber` are the
//                              two most common stages behind a switchboard
//                              number's extensions (42 subscriber records on
//                              one number), which is what they really mean
//                              here — bulk import residue, not prospects.
//
// STILL OPEN (spec Open Item 16): Rincon's marketing manager has not
// formally ratified this list. It is built from observed use and from the
// portal's own labels. If the answer differs, edit here and add a CHANGE
// LOG line — do not edit a call site.
const PROSPECT_LIFECYCLE_STAGES = [
  '2262522612',             // Cold Lead
  '2263492322',             // Warm Lead
  '2263949039',             // Hot Lead
  '4033377998',             // Re-engaged Lead
  'marketingqualifiedlead', // Marketing Qualified Lead
  'opportunity',            // Opportunity
];

// Ordered best-to-worst, for ONE narrow purpose: naming which record
// justified an answer during troubleshooting (Design Decision 19). It
// NEVER changes the answer — the rule is "does ANY matching contact
// qualify," which is order-independent, so there is no tie to break and no
// non-determinism to design around. The marketing manager may rank these
// differently; that would change only what the diagnostic prints.
const PROSPECT_STAGE_PRECEDENCE = [
  'opportunity',
  'marketingqualifiedlead',
  '2263949039', // Hot
  '2263492322', // Warm
  '4033377998', // Re-engaged
  '2262522612', // Cold
];

// ============================================================
// DEAL EVIDENCE — and why this is a contact-level count, not a
// per-deal pipeline check
// ============================================================
// Design Decision 17's second condition is "at least one associated deal
// in a configured pipeline allowlist." It is implemented here as "at least
// one associated deal, in any pipeline," and that is a deliberate
// narrowing of the spec, taken on measured grounds rather than to save
// effort.
//
// LIVE-VERIFIED 2026-09-12, all four pipelines counted directly:
//     Sales Pipeline (default)       1,631 deals
//     RentScale Sales Pipeline           0 deals
//     House Hack Group                   5 deals   (all from 2023)
//     Smartlead Positive Replies         0 deals
//
// So a per-deal pipeline check would cost one extra HubSpot request per
// matched contact carrying a deal — every night, forever — in order to
// exclude at most FIVE deals created in 2023. That trade is not worth
// making, and the request budget matters: Design Decision 20 sells this
// whole design on "one to three requests a night."
//
// The allowlist below is kept because it records the decision and because
// the arithmetic that justifies ignoring it will stop holding the moment
// somebody starts using a second pipeline. WHAT WOULD CHANGE THAT: if
// RentScale or Smartlead ever carries real volume, this becomes a genuine
// source of false SALES classifications, and the per-deal check has to be
// built. The diagnostic script re-counts the four pipelines every time it
// runs, so the assumption is re-checked rather than assumed to keep
// holding. (Spec Open Item 17 — Rincon's decision, not resolved here.)
const DEAL_PIPELINE_ALLOWLIST = ['default'];

// ============================================================
// THE "CONVERSATION" THRESHOLD (scorecard metric 3)
// ============================================================
// A "conversation from an outbound sales call" is an OUTBOUND call to a
// prospect-matched number that CONNECTED (answered_at is set) and whose
// talk time reached this many seconds.
//
// Talk time is computed the way the rest of this tool computes it —
// ended_at minus answered_at — never from Aircall's own `duration` field,
// which aircall-connector.js LIVE VERIFICATION #4 found unreliable.
//
// ------------------------------------------------------------
// WHY 60, AND WHAT IT IS *NOT* BASED ON
// ------------------------------------------------------------
// Peter's only stated requirement was "any kind of meaningful
// conversation — probably over a certain number of seconds." He has no
// view beyond that, so this is a judgment, and the judgment is recorded
// here rather than buried in a commit message.
//
// MEASURED 2026-09-12 over 8,925 real Aircall calls (13 full Pacific
// weeks, 2026-06-08..2026-09-06): 914 connected outbound calls to
// prospect-matched numbers. Distribution: p10 5s, p25 26s, MEDIAN 43s,
// p75 107s, p90 396s, mean 138s.
//
// The distribution is NOT smooth, and the bump is the whole argument. It
// has a pronounced mode at 30-50s carrying 29% of all such calls, against
// 11.9% in the same band for the control group (connected outbound calls
// to NON-prospect numbers, n=3,270). That mode exists for prospect calls
// and essentially does not exist for everything else.
//
// The most plausible reading is outbound voicemail: a rep reaching a
// prospect's voicemail, hearing the greeting and leaving a short message —
// something reps do far more for prospects than for vendors, which is
// exactly the asymmetry the control group shows. 60 seconds is the first
// round value clear of that mode, so it excludes the dominant
// NON-conversation outcome rather than cutting the distribution at an
// arbitrary point.
//
// *** THAT READING IS AN INFERENCE AND IS NOT VERIFIED. *** Aircall
// provides no signal for it: the `voicemail` field is populated ONLY on
// inbound calls (a caller leaving Rincon a message) and was null on every
// outbound call sampled, and `missed_call_reason` is null on them too. An
// outbound call that reaches voicemail is recorded as answered, with
// answered_at set, indistinguishable from a human picking up. So the
// 30-50s mode is a shape consistent with voicemail, not a measurement of
// it. If Aircall ever exposes an outbound-voicemail flag, THAT is the
// correct definition and this threshold should be replaced by it rather
// than tuned.
//
// ------------------------------------------------------------
// *** THIS NUMBER IS NOT REVERSE-ENGINEERED TO PETER'S 5.2/WEEK, AND IT
// DOES NOT REPRODUCE IT. ***
// ------------------------------------------------------------
// At 60s the measured figures are 26.5 conversations/week portfolio-wide
// and 8.3/week for Kristen Rau alone. Peter's hand-kept figure is 5.2.
//
// Landing on 5.2 for Kristen would need roughly an 85-second cut (75s ->
// 6.2/wk, 90s -> 4.5/wk). There is nothing in the distribution at 85
// seconds — no mode, no trough, no structural feature of any kind. Picking
// it would be fitting the definition to the answer, and it would make
// every future reading of this metric a measure of how well 85 seconds was
// tuned in September rather than of how the sales team is doing.
//
// So 60s is defensible on its own evidence and disagrees with Peter's
// count by roughly 60%. The gap is a real, open question about what Peter
// has been counting by hand — see the reporting on scope in
// COMMITTED-NOT-BUILT.md — and it should be resolved by asking him, not by
// moving this constant until the numbers agree.
const CONVERSATION_MIN_TALK_SECONDS = 60;

// ============================================================
// CHANGE LOG — every edit above gets a dated line here.
// A change does NOT rewrite history (Design Decision 22). It creates a
// definitional boundary: days before it were classified under the old
// list, days after under the new one. A date range spanning a line below
// is mixing two definitions.
// ============================================================
// 2026-09-12  Q  Initial lists. Stages built from the portal's own 16 live
//                options (not the spec's stale 21); deal evidence narrowed
//                to "any pipeline" on the measured 1,631/0/5/0 split;
//                conversation threshold set at 60s. Marketing manager has
//                NOT ratified the stage list (Open Item 16) and Rincon has
//                not ruled on pipelines (Open Item 17).

module.exports = {
  PROSPECT_LIFECYCLE_STAGES,
  PROSPECT_STAGE_PRECEDENCE,
  DEAL_PIPELINE_ALLOWLIST,
  CONVERSATION_MIN_TALK_SECONDS,
};
