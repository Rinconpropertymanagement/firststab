#!/usr/bin/env node
/**
 * test/run-tests.js
 *
 * Standalone test runner for the email-intake containment filters — no
 * test framework dependency, matches the "simplest thing that works"
 * standard. Run with: node projects/hub/email-intake/test/run-tests.js
 *
 * Every thread below is fictional test data (see fixtures/threads.js).
 * This script makes zero network calls and touches no real inbox.
 */

const assert = require('assert');
const { checkThread: checkPrivilege } = require('../lib/privilege-filter');
const { scanThread: checkFairHousing, isSafeForDecisionView } = require('../lib/fair-housing-filter');
const fixtures = require('./fixtures/threads');

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
  }
}

// --- Case 1: routine maintenance email passes cleanly on both filters
test('Case 1 — routine maintenance email passes through cleanly', () => {
  const privilege = checkPrivilege(fixtures.routineMaintenance);
  const fairHousing = checkFairHousing(fixtures.routineMaintenance);
  assert.strictEqual(privilege.held, false, 'expected privilege filter NOT to hold this thread');
  assert.strictEqual(fairHousing.flagged, false, 'expected Fair Housing filter NOT to flag this thread');
});

// --- Case 2: government-domain sender, standalone, with no Tier 2 signal
// anywhere in the thread. Under the two-tier split this is now Tier 1 —
// TAGGED, not held. (Was "held" under the original flat binary; that
// change is expected and correct, not a regression — see Mason's review.)
test('Case 2 — government-domain sender alone is Tier 1: tagged, not held', () => {
  const privilege = checkPrivilege(fixtures.governmentDomainSender);
  assert.strictEqual(privilege.held, false, 'expected privilege filter NOT to hold a standalone gov-domain sender (Tier 1 only, no Tier 2 signal present)');
  assert.strictEqual(privilege.tagged, true, 'expected privilege filter to tag this thread');
  assert.strictEqual(privilege.tier, 1, 'expected thread-level tier to be 1');
  assert.ok(privilege.tags.includes('regulatory_matter'), 'expected the regulatory_matter tag');
  const layer1TagHit = privilege.tagReasons.some(
    (tr) => tr.reasons.some((rr) => rr.layer === 1 && rr.tier === 1 && rr.type === 'government_domain')
  );
  assert.ok(layer1TagHit, 'expected a Layer 1 government_domain Tier-1 reason in tagReasons');
});

// --- Case 3: keyword buried deep in a long thread (message 4 of 5, not
// the subject line, not the first message) — proves the scanner checks
// the whole thread, not just the top message.
test('Case 3 — keyword buried deep in thread (message 4 of 5) trips the filter (Tier 2, held)', () => {
  const privilege = checkPrivilege(fixtures.keywordBuriedDeep);
  assert.strictEqual(privilege.held, true, 'expected privilege filter to hold this thread');
  assert.strictEqual(privilege.tier, 2, 'expected thread-level tier to be 2 ("attorney" is a Tier 2 term, unchanged from original build)');
  const triggeringMessage = privilege.perMessage.find((m) => m.messageId === 'm4');
  assert.ok(triggeringMessage.held, 'expected message m4 specifically to be flagged');
  const otherMessagesClean = privilege.perMessage
    .filter((m) => m.messageId !== 'm4')
    .every((m) => m.held === false);
  assert.ok(otherMessagesClean, 'expected messages m1, m2, m3, m5 to individually be clean (proves whole-thread scan, not just subject)');
  const attorneyHit = triggeringMessage.reasons.some(
    (r) => r.layer === 2 && r.tier === 2 && r.matchedTerms.includes('attorney')
  );
  assert.ok(attorneyHit, 'expected "attorney" to be the matched Tier 2 keyword on message m4');
});

// --- Case 4: staff Legal Hold tag set — held regardless of content
test('Case 4 — staff Legal Hold tag holds the thread regardless of content (Tier 2, unchanged)', () => {
  const privilege = checkPrivilege(fixtures.staffLegalHoldTag);
  assert.strictEqual(privilege.held, true, 'expected privilege filter to hold this thread');
  assert.strictEqual(privilege.tier, 2, 'expected thread-level tier to be 2');
  assert.strictEqual(privilege.tagged, false, 'a held thread should never also read as tagged');
  const layer3Hit = privilege.holdReasons.some((r) => r.layer === 3 && r.type === 'staff_legal_hold_tag');
  assert.ok(layer3Hit, 'expected a Layer 3 staff_legal_hold_tag entry in holdReasons');
  // Confirm no message content actually tripped anything — the hold here
  // comes purely from the tag.
  const noMessageTripped = privilege.perMessage.every((m) => m.held === false);
  assert.ok(noMessageTripped, 'expected no individual message to have tripped a filter — hold should come only from the tag');
});

// --- Case 5: mixed thread, one flagged message ("small claims"). CHANGED
// OUTCOME this round: under the prior boundary "small claims" was Tier 2
// and this whole thread held; under Peter's final boundary "small claims"
// moved to Tier 1, so this same fixture now TAGS the whole thread instead
// of holding it. The fixture text is untouched from the prior round — only
// these assertions changed, to prove the behavior actually moved.
test('Case 5 — mixed thread with one flagged message tags the WHOLE thread (Tier 1 — CHANGED from held to tagged this round)', () => {
  const privilege = checkPrivilege(fixtures.mixedThreadOneFlaggedMessage);
  assert.strictEqual(privilege.held, false, 'expected the thread NOT to be held — "small claims" is now Tier 1, not Tier 2');
  assert.strictEqual(privilege.tagged, true, 'expected the whole thread to be tagged');
  assert.strictEqual(privilege.tier, 1, 'expected thread-level tier to be 1 now ("small claims" moved from Tier 2 to Tier 1 this round)');
  assert.ok(privilege.tags.includes('regulatory_matter'), 'expected the regulatory_matter tag');
  const m1 = privilege.perMessage.find((m) => m.messageId === 'm1');
  const m2 = privilege.perMessage.find((m) => m.messageId === 'm2');
  const m3 = privilege.perMessage.find((m) => m.messageId === 'm3');
  assert.strictEqual(m1.tier, 0, 'm1 alone should not trip anything');
  assert.strictEqual(m2.tier, 0, 'm2 alone should not trip anything');
  assert.strictEqual(m3.tier, 1, 'm3 should trip the keyword filter ("small claims") at Tier 1 now, not Tier 2');
  // The key assertion: thread.tagged is true even though only ONE of three
  // messages tripped a filter — the same "whole thread" propagation applies
  // to tagging as it did to holding before.
  assert.strictEqual(privilege.tagged, true, 'thread-level tagged must be true because ANY message tripped, not ALL');
});

// --- Case 6: health/disability-adjacent content — detected and tagged,
// not silently passed through as routine.
test('Case 6 — health/disability content is detected and tagged by the Fair Housing filter', () => {
  const fairHousing = checkFairHousing(fixtures.healthDisabilityContent);
  assert.strictEqual(fairHousing.flagged, true, 'expected Fair Housing filter to flag this thread');
  assert.ok(fairHousing.categories.includes('disability_health'), 'expected disability_health category to be present');
  assert.strictEqual(isSafeForDecisionView(fairHousing), false, 'expected this thread to be walled off from decision-adjacent view');

  // Also confirm the privilege filter, which catches a different kind of
  // risk, correctly does NOT hold this one — proves the two filters are
  // independent and this isn't accidentally passing because of a shared
  // bug.
  const privilege = checkPrivilege(fixtures.healthDisabilityContent);
  assert.strictEqual(privilege.held, false, 'expected privilege filter NOT to hold a purely health/disability-content thread (no gov domain, no privilege keyword)');
  assert.strictEqual(privilege.tagged, false, 'expected privilege filter NOT to tag this thread either — no Tier 1 signal present');
  assert.strictEqual(privilege.tier, 0, 'expected thread-level tier to be 0 (neither filter is tripped by this content)');
});

// --- Case 7: nothing sensitive at all — passes both filters
test('Case 7 — thread with nothing sensitive passes BOTH filters', () => {
  const privilege = checkPrivilege(fixtures.cleanThreadBothFilters);
  const fairHousing = checkFairHousing(fixtures.cleanThreadBothFilters);
  assert.strictEqual(privilege.held, false, 'expected privilege filter NOT to hold this thread');
  assert.strictEqual(privilege.tagged, false, 'expected privilege filter NOT to tag this thread');
  assert.strictEqual(privilege.tier, 0, 'expected thread-level tier to be 0');
  assert.strictEqual(fairHousing.flagged, false, 'expected Fair Housing filter NOT to flag this thread');
  assert.strictEqual(isSafeForDecisionView(fairHousing), true, 'expected this thread to be safe for decision-adjacent view');
});

// --- Case 8 (new): only Tier 1 signals in the thread (government-domain
// sender + "code compliance"/"citation"/"case no." keywords, no Tier 2
// signal anywhere) — should be TAGGED, not held.
test('Case 8 — thread with only Tier 1 terms is tagged, not held', () => {
  const privilege = checkPrivilege(fixtures.tier1OnlyThread);
  assert.strictEqual(privilege.held, false, 'expected privilege filter NOT to hold a Tier-1-only thread');
  assert.strictEqual(privilege.tagged, true, 'expected privilege filter to tag this thread');
  assert.strictEqual(privilege.tier, 1, 'expected thread-level tier to be 1');
  assert.ok(privilege.tags.includes('regulatory_matter'), 'expected the regulatory_matter tag');
  // Confirm the specific Tier 1 keyword hits are the ones that tripped it.
  const m1 = privilege.perMessage.find((m) => m.messageId === 'm1');
  assert.strictEqual(m1.tagged, true, 'expected m1 to be tagged');
  const matchedTagTerms = m1.reasons
    .filter((r) => r.layer === 2 && r.tier === 1)
    .flatMap((r) => r.matchedTerms);
  assert.ok(matchedTagTerms.includes('code compliance'), 'expected "code compliance" among matched Tier 1 terms');
  assert.ok(matchedTagTerms.includes('citation'), 'expected "citation" among matched Tier 1 terms');
  // Confirm no Tier 2 reason exists anywhere.
  const anyTier2Reason = privilege.perMessage.some((m) => m.reasons.some((r) => r.tier === 2));
  assert.strictEqual(anyTier2Reason, false, 'expected no Tier 2 reasons anywhere in this thread');
});

// --- Case 9 (new): only Tier 2 signals (law-firm-domain sender +
// "attorney") — should be HELD, same as the original build's behavior for
// legal-exposure content.
test('Case 9 — thread with only Tier 2 terms is held, same as before', () => {
  const privilege = checkPrivilege(fixtures.tier2OnlyThread);
  assert.strictEqual(privilege.held, true, 'expected privilege filter to hold a Tier-2 thread');
  assert.strictEqual(privilege.tagged, false, 'a held thread should never also read as tagged');
  assert.strictEqual(privilege.tier, 2, 'expected thread-level tier to be 2');
  const m1 = privilege.perMessage.find((m) => m.messageId === 'm1');
  const lawFirmHit = m1.reasons.some((r) => r.layer === 1 && r.tier === 2 && r.type === 'law_firm_domain');
  const attorneyHit = m1.reasons.some((r) => r.layer === 2 && r.tier === 2 && r.matchedTerms.includes('attorney'));
  assert.ok(lawFirmHit, 'expected a law_firm_domain Tier 2 hit');
  assert.ok(attorneyHit, 'expected an "attorney" Tier 2 keyword hit');
});

// --- Case 10 (new): mixed thread — starts as routine Tier 1 code-compliance
// chatter, a later message trips a Tier 2 term ("our attorney advised...").
// The WHOLE thread must hold, not just be tagged and not just that message.
test('Case 10 — thread that starts Tier 1 and later trips Tier 2 holds the WHOLE thread', () => {
  const privilege = checkPrivilege(fixtures.mixedTier1ThenTier2Thread);
  assert.strictEqual(privilege.held, true, 'expected the whole thread to be held once ANY message trips Tier 2');
  assert.strictEqual(privilege.tagged, false, 'a held thread should never also read as tagged');
  assert.strictEqual(privilege.tier, 2, 'expected thread-level tier to be 2 — Tier 2 overrides the earlier Tier 1 signal');
  const m1 = privilege.perMessage.find((m) => m.messageId === 'm1');
  const m3 = privilege.perMessage.find((m) => m.messageId === 'm3');
  assert.strictEqual(m1.tier, 1, 'expected m1 alone to read as Tier 1 ("citation")');
  assert.strictEqual(m3.tier, 2, 'expected m3 alone to read as Tier 2 ("attorney")');
  // holdReasons should reference m3 as the trigger for the whole-thread hold.
  const holdTriggeredByM3 = privilege.holdReasons.some(
    (r) => r.layer === 4 && r.triggeredByMessageId === 'm3'
  );
  assert.ok(holdTriggeredByM3, 'expected holdReasons to show m3 as the message that triggered the whole-thread hold');
});

// --- Case 11 (new, final-boundary round): a thread whose ONLY signals are
// the three moved terms — "litigation", "lawsuit", "small claims" — one per
// message, no domain signal, no other keyword. Confirms the changed
// behavior explicitly and in isolation from Case 5's mixed-content thread.
test('Case 11 — thread with only litigation/lawsuit/small claims is tagged, not held (changed behavior)', () => {
  const privilege = checkPrivilege(fixtures.litigationLawsuitSmallClaimsOnly);
  assert.strictEqual(privilege.held, false, 'expected NOT held — none of these three terms are Tier 2 anymore');
  assert.strictEqual(privilege.tagged, true, 'expected the thread to be tagged');
  assert.strictEqual(privilege.tier, 1, 'expected thread-level tier to be 1');
  assert.ok(privilege.tags.includes('regulatory_matter'), 'expected the regulatory_matter tag');
  const m1 = privilege.perMessage.find((m) => m.messageId === 'm1');
  const m2 = privilege.perMessage.find((m) => m.messageId === 'm2');
  const m3 = privilege.perMessage.find((m) => m.messageId === 'm3');
  assert.ok(m1.reasons.some((r) => r.tier === 1 && r.matchedTerms && r.matchedTerms.includes('litigation')), 'expected "litigation" matched at Tier 1 on m1');
  assert.ok(m2.reasons.some((r) => r.tier === 1 && r.matchedTerms && r.matchedTerms.includes('lawsuit')), 'expected "lawsuit" matched at Tier 1 on m2');
  assert.ok(m3.reasons.some((r) => r.tier === 1 && r.matchedTerms && r.matchedTerms.includes('small claims')), 'expected "small claims" matched at Tier 1 on m3');
  const anyTier2Reason = privilege.perMessage.some((m) => m.reasons.some((r) => r.tier === 2));
  assert.strictEqual(anyTier2Reason, false, 'expected no Tier 2 reasons anywhere in this thread');
});

// --- Case 12 (new, final-boundary round): "subpoena" and "demand letter" —
// unchanged Tier 2 terms not previously covered by any fixture. Confirms
// they still hold under the final boundary.
test('Case 12 — thread with subpoena/demand letter still holds (unchanged)', () => {
  const privilege = checkPrivilege(fixtures.subpoenaDemandLetterThread);
  assert.strictEqual(privilege.held, true, 'expected the thread to be held');
  assert.strictEqual(privilege.tagged, false, 'a held thread should never also read as tagged');
  assert.strictEqual(privilege.tier, 2, 'expected thread-level tier to be 2');
  const m1 = privilege.perMessage.find((m) => m.messageId === 'm1');
  const m2 = privilege.perMessage.find((m) => m.messageId === 'm2');
  assert.ok(m1.reasons.some((r) => r.tier === 2 && r.matchedTerms && r.matchedTerms.includes('subpoena')), 'expected "subpoena" matched at Tier 2 on m1');
  assert.ok(m2.reasons.some((r) => r.tier === 2 && r.matchedTerms && r.matchedTerms.includes('demand letter')), 'expected "demand letter" matched at Tier 2 on m2');
});

// --- Case 13 (new, final-boundary round): "fair housing complaint", "hud
// complaint", "crd complaint" — unchanged Tier 2 terms not previously
// covered by any fixture. Confirms they still hold under the final
// boundary.
test('Case 13 — thread with fair housing/HUD/CRD complaint still holds (unchanged)', () => {
  const privilege = checkPrivilege(fixtures.fairHousingHudCrdComplaintThread);
  assert.strictEqual(privilege.held, true, 'expected the thread to be held');
  assert.strictEqual(privilege.tagged, false, 'a held thread should never also read as tagged');
  assert.strictEqual(privilege.tier, 2, 'expected thread-level tier to be 2');
  const m1 = privilege.perMessage.find((m) => m.messageId === 'm1');
  const m2 = privilege.perMessage.find((m) => m.messageId === 'm2');
  const m3 = privilege.perMessage.find((m) => m.messageId === 'm3');
  assert.ok(m1.reasons.some((r) => r.tier === 2 && r.matchedTerms && r.matchedTerms.includes('fair housing complaint')), 'expected "fair housing complaint" matched at Tier 2 on m1');
  assert.ok(m2.reasons.some((r) => r.tier === 2 && r.matchedTerms && r.matchedTerms.includes('hud complaint')), 'expected "hud complaint" matched at Tier 2 on m2');
  assert.ok(m3.reasons.some((r) => r.tier === 2 && r.matchedTerms && r.matchedTerms.includes('crd complaint')), 'expected "crd complaint" matched at Tier 2 on m3');
});

// --- Report ---
console.log('\nEmail Intake Containment — Test Results\n' + '='.repeat(60));
let failCount = 0;
for (const r of results) {
  if (r.pass) {
    console.log(`PASS  ${r.name}`);
  } else {
    failCount += 1;
    console.log(`FAIL  ${r.name}`);
    console.log(`      ${r.error}`);
  }
}
console.log('='.repeat(60));
console.log(`${results.length - failCount}/${results.length} passed`);

if (failCount > 0) {
  process.exitCode = 1;
}
