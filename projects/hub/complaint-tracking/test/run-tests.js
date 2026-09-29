#!/usr/bin/env node
/**
 * test/run-tests.js
 * Standalone test runner for complaint-tracking/lib/thread-adapter.js — no
 * test framework dependency, matching archive-search/test/run-tests.js's
 * own convention. Run with:
 *   node projects/hub/complaint-tracking/test/run-tests.js
 *
 * Makes zero real network calls and touches no real Supabase project or
 * Anthropic account — thread-adapter.js has no external dependencies at
 * all, so no fake env values are needed here.
 *
 * SCOPE: this file currently covers only the 2026-09-17 prototype,
 * threadFullTextBounded() — a disposable, standalone function built for
 * TARS to validate the "clean formatting, capped to the most recent N
 * messages" cost-reduction approach against real data. It is NOT wired
 * into significance-pass.js or any other real pipeline code. threadFullText()
 * itself is untouched by that prototype; existing coverage of it (if any)
 * lives elsewhere and this file does not attempt to duplicate it.
 */

const assert = require('assert');

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
  }
}

const { toThreadShape, threadFullText, threadFullTextBounded } = require('../lib/thread-adapter');

// ============================================================
// Fixtures — real message-row shape (missive_message_intake columns), fed
// through the real toThreadShape() exactly the way process-pending-
// messages.js does, so these tests exercise threadFullTextBounded() against
// the same object shape threadFullText() actually receives in production.
// ============================================================

// Builds `count` rows for one conversation, oldest first, each with a
// distinguishable body so message order/identity is easy to assert on.
function makeRows(count, { conversationId = 'conv-1' } = {}) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({
      missive_message_id: `msg-${i}`,
      from_address: i % 2 === 0 ? { address: 'owner@example.com', name: 'Owner' } : { address: 'tenant@example.com', name: 'Tenant' },
      to_addresses: [{ address: 'staff@rinconmanagement.com' }],
      cc_addresses: [],
      bcc_addresses: [],
      subject: `Re: Maintenance request (message ${i})`,
      body_text: `This is the body of message ${i} of ${count}.`,
      // Strictly increasing so sort order in toThreadShape is unambiguous.
      delivered_at: new Date(2026, 0, i).toISOString(),
    });
  }
  return rows;
}

// ============================================================
// (a) Short threads pass through byte-for-byte unchanged, for every
// maxMessages TARS needs to test (5 and 8), across the boundary (fewer
// than, and exactly equal to, maxMessages).
// ============================================================

for (const maxMessages of [5, 8]) {
  test(`threadFullTextBounded — thread shorter than maxMessages=${maxMessages} is byte-for-byte identical to threadFullText()`, () => {
    const thread = toThreadShape('conv-short', makeRows(maxMessages - 2));
    const expected = threadFullText(thread);
    const actual = threadFullTextBounded(thread, maxMessages);
    assert.strictEqual(actual, expected);
  });

  test(`threadFullTextBounded — thread with EXACTLY maxMessages=${maxMessages} messages is byte-for-byte identical to threadFullText() (boundary case, no marker)`, () => {
    const thread = toThreadShape('conv-exact', makeRows(maxMessages));
    const expected = threadFullText(thread);
    const actual = threadFullTextBounded(thread, maxMessages);
    assert.strictEqual(actual, expected);
    assert.ok(!actual.includes('omitted'), 'expected no omission marker when the thread is not actually truncated');
  });
}

test('threadFullTextBounded — a genuinely empty thread (zero messages) matches threadFullText() (both empty string)', () => {
  const thread = toThreadShape('conv-empty', []);
  assert.strictEqual(threadFullTextBounded(thread, 5), threadFullText(thread));
  assert.strictEqual(threadFullTextBounded(thread, 5), '');
});

// ============================================================
// (b) + (c) Long threads get bounded to the right message count, with an
// omission marker present and stating the correct real count of omitted
// messages — for both maxMessages values TARS needs (5 and 8), and at a
// realistic "very long" size (the kind of 50,000+ token thread this
// prototype exists for).
// ============================================================

for (const [totalMessages, maxMessages] of [
  [12, 5],
  [12, 8],
  [40, 5],
  [40, 8],
]) {
  test(`threadFullTextBounded — a ${totalMessages}-message thread bounded to maxMessages=${maxMessages} keeps exactly ${maxMessages} messages and states the correct omitted count (${totalMessages - maxMessages})`, () => {
    const rows = makeRows(totalMessages);
    const thread = toThreadShape('conv-long', rows);
    const bounded = threadFullTextBounded(thread, maxMessages);

    const omittedCount = totalMessages - maxMessages;
    const expectedMarker = `[${omittedCount} earlier message${omittedCount === 1 ? '' : 's'} omitted — thread continues below]`;
    assert.ok(bounded.includes(expectedMarker), `expected the marker "${expectedMarker}" in the output`);

    // Exactly maxMessages message bodies present, and they are the LAST
    // maxMessages (most recent), not the first — the whole point of
    // "recent messages" bounding.
    for (let i = 1; i <= totalMessages; i += 1) {
      const marker = `body of message ${i} of ${totalMessages}.`;
      const shouldBePresent = i > totalMessages - maxMessages;
      assert.strictEqual(
        bounded.includes(marker),
        shouldBePresent,
        `message ${i} should ${shouldBePresent ? '' : 'NOT '}be present in the bounded output`
      );
    }
  });
}

test('threadFullTextBounded — omission marker uses singular "message" when exactly one message is omitted', () => {
  const thread = toThreadShape('conv-one-over', makeRows(6));
  const bounded = threadFullTextBounded(thread, 5);
  assert.ok(bounded.includes('[1 earlier message omitted — thread continues below]'), 'expected singular phrasing for exactly 1 omitted message');
  assert.ok(!bounded.includes('1 earlier messages'), 'expected no plural "messages" when the count is 1');
});

// ============================================================
// (d) No formatting drift: the per-message formatting inside the bounded
// output for the messages it DOES keep must exactly match what
// threadFullText() itself produces for those same messages — proving the
// two functions render messages identically, not just similarly.
// ============================================================

test('threadFullTextBounded — the retained messages\' formatting is byte-for-byte identical to threadFullText() run on just those messages (no formatting drift)', () => {
  const totalMessages = 12;
  const maxMessages = 5;
  const rows = makeRows(totalMessages);
  const thread = toThreadShape('conv-drift-check', rows);

  const bounded = threadFullTextBounded(thread, maxMessages);

  // Independently compute "what threadFullText() would produce for just
  // the last maxMessages messages" by slicing the already-sorted thread
  // object and calling the real, untouched threadFullText() on that
  // subset — this is the actual production formatting code, not a
  // reimplementation of it.
  const expectedTail = threadFullText({ messages: thread.messages.slice(-maxMessages) });

  assert.ok(bounded.endsWith(expectedTail), 'expected the bounded output to end with exactly threadFullText()\'s own formatting of the retained messages');

  // And the marker plus separator is exactly what precedes that tail —
  // proving there's no stray extra content, only the honest omission
  // marker sits in front of the real formatting.
  const omittedCount = totalMessages - maxMessages;
  const expectedMarker = `[${omittedCount} earlier messages omitted — thread continues below]`;
  assert.strictEqual(bounded, `${expectedMarker}\n\n---\n\n${expectedTail}`);
});

test('threadFullTextBounded — each individual retained message\'s From/Date/Subject/body block matches threadFullText()\'s own single-message rendering', () => {
  const rows = makeRows(9);
  const thread = toThreadShape('conv-per-message-check', rows);
  const bounded = threadFullTextBounded(thread, 5);

  const lastFive = thread.messages.slice(-5);
  for (const m of lastFive) {
    const singleMessageRendering = threadFullText({ messages: [m] });
    assert.ok(bounded.includes(singleMessageRendering), `expected the exact threadFullText() rendering of message ${m.messageId} inside the bounded output`);
  }
});

// ============================================================
// threadFullText() itself is provably untouched — same call, same
// arguments, same result as before this prototype existed. This is a
// behavioral smoke check, not a guess: any accidental edit to
// threadFullText() that changed its output would fail this.
// ============================================================

test('threadFullText() itself is unchanged — produces its known, exact format for a simple 2-message thread', () => {
  const rows = makeRows(2);
  const thread = toThreadShape('conv-untouched-check', rows);
  const out = threadFullText(thread);
  const expected =
    'From: tenant@example.com\nDate: ' + thread.messages[0].date + '\nSubject: Re: Maintenance request (message 1)\n\nThis is the body of message 1 of 2.' +
    '\n\n---\n\n' +
    'From: owner@example.com\nDate: ' + thread.messages[1].date + '\nSubject: Re: Maintenance request (message 2)\n\nThis is the body of message 2 of 2.';
  assert.strictEqual(out, expected);
});

// ============================================================
// Input validation — a clear, immediate error for a nonsensical
// maxMessages rather than silently misbehaving.
// ============================================================

test('threadFullTextBounded — throws a clear error for a non-positive maxMessages', () => {
  const thread = toThreadShape('conv-validate', makeRows(3));
  assert.throws(() => threadFullTextBounded(thread, 0), /positive integer/);
  assert.throws(() => threadFullTextBounded(thread, -1), /positive integer/);
});

test('threadFullTextBounded — throws a clear error for a non-integer maxMessages', () => {
  const thread = toThreadShape('conv-validate-2', makeRows(3));
  assert.throws(() => threadFullTextBounded(thread, 5.5), /positive integer/);
});

// ─── Report ──────────────────────────────────────────────────────────────
console.log('\nComplaint Tracking — thread-adapter.js Test Suite\n' + '='.repeat(60));
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

if (failCount > 0) process.exitCode = 1;
