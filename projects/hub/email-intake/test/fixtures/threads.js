/**
 * test/fixtures/threads.js
 *
 * Hand-authored, fully fictional test threads for the privilege filter and
 * Fair Housing filter. Every name, address, and detail below is invented
 * for this test file — none of it is drawn from or resembles any real
 * correspondence. Nothing here is sent anywhere; these are plain JS
 * objects fed directly into the filter functions in unit tests.
 */

// --- Case 1: normal, routine maintenance email — should pass through
// cleanly on both filters.
const routineMaintenance = {
  threadId: 'test-thread-001',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'sam.testtenant@example-resident-mail.test',
      to: ['maintenance@rincon-test-inbox.test'],
      cc: [],
      subject: 'Leaky kitchen faucet in unit 4B',
      body:
        'Hi, the kitchen faucet in unit 4B has been dripping steadily for a ' +
        'few days. Could someone from maintenance take a look this week? ' +
        'It is not urgent, just wanted to get it on the list before it gets ' +
        'worse. Thanks, Sam',
      date: '2026-08-01T10:00:00Z',
    },
  ],
};

// --- Case 2: government-domain sender should trip the privilege filter
// (Layer 1).
const governmentDomainSender = {
  threadId: 'test-thread-002',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'inspector.morales@codeenforcement.cityoftestville.gov',
      to: ['compliance@rincon-test-inbox.test'],
      cc: [],
      subject: 'Follow-up on recent property inspection',
      body:
        'This is a follow-up regarding the inspection conducted at the ' +
        'property last week. Please confirm a good time for a re-check.',
      date: '2026-08-02T09:00:00Z',
    },
  ],
};

// --- Case 3: keyword buried deep in a long thread, not the subject line
// and not the first message — mirrors the real finding that the risky
// content was on page 50 of a 94-page thread. Five messages, all routine
// except message 4, which buries a trigger term inside a long paragraph.
const filler = (n) =>
  `This is routine follow-up message number ${n} in an ongoing thread about ` +
  'move-out walkthrough scheduling, key return logistics, and general ' +
  'coordination between the resident and the property team. Nothing in ' +
  'this particular message concerns anything legal or sensitive — it is ' +
  'just calendar back-and-forth about timing, parking for the move truck, ' +
  'and confirming the unit is left broom-clean.';

const keywordBuriedDeep = {
  threadId: 'test-thread-003',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'jordan.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Move-out walkthrough notes',
      body: filler(1),
      date: '2026-07-01T09:00:00Z',
    },
    {
      messageId: 'm2',
      from: 'leasing@rincon-test-inbox.test',
      to: ['jordan.testresident@example-resident-mail.test'],
      subject: 'Re: Move-out walkthrough notes',
      body: filler(2),
      date: '2026-07-03T09:00:00Z',
    },
    {
      messageId: 'm3',
      from: 'jordan.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Move-out walkthrough notes',
      body: filler(3),
      date: '2026-07-08T09:00:00Z',
    },
    {
      // The buried message — trigger term appears mid-paragraph, subject
      // line stays the same generic "Re: Move-out walkthrough notes".
      messageId: 'm4',
      from: 'jordan.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Move-out walkthrough notes',
      body:
        'Following up again on scheduling. Separately, and I probably ' +
        'should have mentioned this sooner, our attorney advised us to ' +
        'document everything about the deposit deductions in writing before ' +
        'we sign off on the walkthrough, so please treat this thread as ' +
        'part of that record going forward. Otherwise the move-out time of ' +
        '10am on the 15th still works fine for us.',
      date: '2026-07-10T09:00:00Z',
    },
    {
      messageId: 'm5',
      from: 'leasing@rincon-test-inbox.test',
      to: ['jordan.testresident@example-resident-mail.test'],
      subject: 'Re: Move-out walkthrough notes',
      body: filler(5),
      date: '2026-07-11T09:00:00Z',
    },
  ],
};

// --- Case 4: staff "Legal Hold" tag set — should be held regardless of
// content, even though nothing in the messages themselves is sensitive.
const staffLegalHoldTag = {
  threadId: 'test-thread-004',
  legalHoldTag: true,
  messages: [
    {
      messageId: 'm1',
      from: 'taylor.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Question about parking assignment',
      body: 'Hi, just wanted to confirm which parking spot comes with unit 12.',
      date: '2026-08-03T09:00:00Z',
    },
  ],
};

// --- Case 5: mixed thread — two routine messages, one message trips a
// keyword filter ("small claims"). UNDER PETER'S FINAL BOUNDARY THIS
// OUTCOME CHANGED: "small claims" moved from Tier 2 (HOLD) to Tier 1 (TAG)
// in the last round, so this thread is now TAGGED, not held — see
// run-tests.js Case 5 for the updated assertions. The fixture text is left
// exactly as it was in the prior round on purpose, so this same input
// demonstrates the before/after behavior change directly.
const mixedThreadOneFlaggedMessage = {
  threadId: 'test-thread-005',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'riley.testresident@example-resident-mail.test',
      to: ['maintenance@rincon-test-inbox.test'],
      subject: 'Garbage disposal not working',
      body: 'The garbage disposal in unit 7 stopped working yesterday.',
      date: '2026-08-04T09:00:00Z',
    },
    {
      messageId: 'm2',
      from: 'maintenance@rincon-test-inbox.test',
      to: ['riley.testresident@example-resident-mail.test'],
      subject: 'Re: Garbage disposal not working',
      body: 'Thanks for the note, a vendor is scheduled for Thursday between 9-11am.',
      date: '2026-08-04T11:00:00Z',
    },
    {
      messageId: 'm3',
      from: 'riley.testresident@example-resident-mail.test',
      to: ['maintenance@rincon-test-inbox.test'],
      subject: 'Re: Garbage disposal not working',
      body:
        'Thursday works. Also, unrelated, I want to flag that I already filed ' +
        'a small claims case about a different issue from last year and my ' +
        'paperwork references this unit, so please keep that in mind.',
      date: '2026-08-04T12:00:00Z',
    },
  ],
};

// --- Case 6: health/disability-adjacent content tied to a habitability
// issue — should be detected and tagged by the Fair Housing filter, not
// silently passed through as routine maintenance. (Privilege filter should
// NOT hold this one — no gov domain, no privilege keyword — proving the
// two filters catch different things.)
const healthDisabilityContent = {
  threadId: 'test-thread-006',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'casey.testresident@example-resident-mail.test',
      to: ['maintenance@rincon-test-inbox.test'],
      subject: 'Mold in bathroom is getting worse',
      body:
        'The mold in the bathroom ceiling has spread since I last reported ' +
        'it. I have severe asthma and it has been triggering breathing ' +
        'problems the last few nights. I may need this treated as a ' +
        'reasonable accommodation given my medical condition — can someone ' +
        'call me today?',
      date: '2026-08-05T09:00:00Z',
    },
  ],
};

// --- Case 7: nothing sensitive at all — a multi-message thread that
// should cleanly pass BOTH filters.
const cleanThreadBothFilters = {
  threadId: 'test-thread-007',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'morgan.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Renewal question',
      body: 'Hi, just wanted to ask what the renewal rent would be for another 12-month term.',
      date: '2026-08-06T09:00:00Z',
    },
    {
      messageId: 'm2',
      from: 'leasing@rincon-test-inbox.test',
      to: ['morgan.testresident@example-resident-mail.test'],
      subject: 'Re: Renewal question',
      body: 'Happy to send that over — give us a day or two to pull the numbers together.',
      date: '2026-08-06T13:00:00Z',
    },
    {
      messageId: 'm3',
      from: 'morgan.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Renewal question',
      body: 'Sounds good, no rush. Thanks!',
      date: '2026-08-06T13:30:00Z',
    },
  ],
};

// --- Case 8: only Tier 1 signals anywhere in the thread — a
// government-domain sender AND a Tier 1 keyword ("code compliance"), no
// Tier 2 signal at all. Should be TAGGED, not held.
const tier1OnlyThread = {
  threadId: 'test-thread-008',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'inspector.diaz@codecompliance.cityoftestville.gov',
      to: ['compliance@rincon-test-inbox.test'],
      cc: [],
      subject: 'Code compliance follow-up — Case No. TV-2026-0417',
      body:
        'This is a routine code compliance follow-up regarding the ' +
        'citation issued last month. Please confirm the repair has been ' +
        'completed so we can close out the case.',
      date: '2026-08-07T09:00:00Z',
    },
    {
      messageId: 'm2',
      from: 'compliance@rincon-test-inbox.test',
      to: ['inspector.diaz@codecompliance.cityoftestville.gov'],
      subject: 'Re: Code compliance follow-up — Case No. TV-2026-0417',
      body: 'Confirmed, the repair was completed on the 5th. Let us know if you need photos.',
      date: '2026-08-07T14:00:00Z',
    },
  ],
};

// --- Case 9: only Tier 2 signals — a law-firm-domain sender AND a Tier 2
// keyword ("attorney"), no Tier 1 signal. Should be HELD, same as the
// original build's behavior for legal-exposure content.
const tier2OnlyThread = {
  threadId: 'test-thread-009',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'j.reyes@reyesandpartnerslaw.com',
      to: ['leasing@rincon-test-inbox.test'],
      cc: [],
      subject: 'Representation notice',
      body:
        'Please be advised this office represents the tenant of unit 9 as ' +
        'attorney of record in connection with the security deposit dispute. ' +
        'Please direct all further communication to this office.',
      date: '2026-08-08T09:00:00Z',
    },
  ],
};

// --- Case 10: mixed thread — starts as routine Tier 1 code-compliance
// chatter, then a later message trips a Tier 2 term ("our attorney
// advised..."). The WHOLE thread should HOLD, not just be tagged, and not
// just the one triggering message.
const mixedTier1ThenTier2Thread = {
  threadId: 'test-thread-010',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'inspector.diaz@codecompliance.cityoftestville.gov',
      to: ['compliance@rincon-test-inbox.test'],
      subject: 'Code compliance follow-up',
      body: 'This is a routine code compliance follow-up on the citation from last month.',
      date: '2026-08-09T09:00:00Z',
    },
    {
      messageId: 'm2',
      from: 'compliance@rincon-test-inbox.test',
      to: ['inspector.diaz@codecompliance.cityoftestville.gov'],
      subject: 'Re: Code compliance follow-up',
      body: 'Understood, we are scheduling the repair for next week.',
      date: '2026-08-09T13:00:00Z',
    },
    {
      messageId: 'm3',
      from: 'compliance@rincon-test-inbox.test',
      to: ['inspector.diaz@codecompliance.cityoftestville.gov'],
      subject: 'Re: Code compliance follow-up',
      body:
        'One update — our attorney advised us to also document the ' +
        'repair timeline in writing before we respond further, so there ' +
        'may be a short delay while we get that together.',
      date: '2026-08-10T10:00:00Z',
    },
  ],
};

// --- Case 11 (new, final-boundary round): a thread where the ONLY signals
// anywhere are the three terms that just moved tiers — "litigation",
// "lawsuit", "small claims" — one per message, no gov/law-firm domain, no
// other keyword. Should be TAGGED (Tier 1), not held — this is the
// changed behavior from this round, tested directly and in isolation.
const litigationLawsuitSmallClaimsOnly = {
  threadId: 'test-thread-011',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'drew.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Parking dispute with neighbor',
      body:
        'Just a heads up — I heard through the grapevine that this could turn ' +
        'into litigation down the road, though nothing has actually been ' +
        'filed. Wanted you to be aware in case it comes up.',
      date: '2026-08-11T09:00:00Z',
    },
    {
      messageId: 'm2',
      from: 'drew.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Parking dispute with neighbor',
      body:
        'Separately, my neighbor mentioned he is considering a lawsuit over ' +
        'the same parking issue, but as far as I know he has not taken any ' +
        'steps yet.',
      date: '2026-08-11T10:00:00Z',
    },
    {
      messageId: 'm3',
      from: 'drew.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Parking dispute with neighbor',
      body:
        'And for what it is worth, I already filed a small claims case ' +
        'about an unrelated matter last year — just mentioning it for ' +
        'context, not asking for anything from you on that one.',
      date: '2026-08-11T11:00:00Z',
    },
  ],
};

// --- Case 12 (new, final-boundary round): "subpoena" and "demand letter" —
// unchanged Tier 2 terms, not previously covered by any fixture ("attorney"
// is already covered by Cases 3 and 9). Should still HOLD.
const subpoenaDemandLetterThread = {
  threadId: 'test-thread-012',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'morgan.testresident2@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Documents requested',
      body: 'We received a subpoena related to a matter involving our unit and wanted to give you notice.',
      date: '2026-08-12T09:00:00Z',
    },
    {
      messageId: 'm2',
      from: 'morgan.testresident2@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Documents requested',
      body: 'Also sending this as a formal demand letter regarding the deposit we believe is owed.',
      date: '2026-08-12T10:00:00Z',
    },
  ],
};

// --- Case 13 (new, final-boundary round): "fair housing complaint", "hud
// complaint", "crd complaint" — unchanged Tier 2 terms, not previously
// covered by any fixture. Should still HOLD.
const fairHousingHudCrdComplaintThread = {
  threadId: 'test-thread-013',
  legalHoldTag: false,
  messages: [
    {
      messageId: 'm1',
      from: 'jamie.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Formal notice',
      body: 'I want to formally note that I am filing a fair housing complaint regarding how this request was handled.',
      date: '2026-08-13T09:00:00Z',
    },
    {
      messageId: 'm2',
      from: 'jamie.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Formal notice',
      body: 'To be clear, we intend to submit a HUD complaint if this is not resolved this week.',
      date: '2026-08-13T10:00:00Z',
    },
    {
      messageId: 'm3',
      from: 'jamie.testresident@example-resident-mail.test',
      to: ['leasing@rincon-test-inbox.test'],
      subject: 'Re: Formal notice',
      body: 'We are also considering a CRD complaint given the pattern we have seen.',
      date: '2026-08-13T11:00:00Z',
    },
  ],
};

module.exports = {
  routineMaintenance,
  governmentDomainSender,
  keywordBuriedDeep,
  staffLegalHoldTag,
  mixedThreadOneFlaggedMessage,
  healthDisabilityContent,
  cleanThreadBothFilters,
  tier1OnlyThread,
  tier2OnlyThread,
  mixedTier1ThenTier2Thread,
  litigationLawsuitSmallClaimsOnly,
  subpoenaDemandLetterThread,
  fairHousingHudCrdComplaintThread,
};
