#!/usr/bin/env node
/**
 * test/run-tests.js
 * Integration tests for the Work Order Alert description block (no AI, local
 * screen). No test framework. Run with:
 *   node projects/hub/approval-briefing/test/run-tests.js
 * The other files in this folder (cleaner-tests.js, screen-corpus.js,
 * no-ai-proof.js) are run together with this one by run-all.js.
 *
 * SAFETY: no real email, no real database, no real Latchel, no model call, no
 * .env read. harness.js replaces every external dependency before the alert
 * module loads, turns the Anthropic client into a tripwire, and trips a wire on
 * global.fetch. All text below is invented.
 */

const K = require('./test-kit'); // first: sets env, stubs, tripwires
const {
  H, assert, path, alert, summaryMod, SCENARIOS, baseProperty, baseJob,
  HEADER, HELD_NOTICE, UNASSIGNED_NOTICE, DESC_ACTION, CANARY,
  clone, goldenByName, FORBIDDEN_WORDS, hasLoneSurrogate,
  send, auditEvents, blockLines, everythingExceptBody, assertIdenticalToGolden, freshAlert,
} = K;
const fs = require('fs');
const {
  prepareWorkOrderSummary, descriptionMode, descriptionModeInfo, truncate,
  NONE_LINE, UNAVAILABLE_LINE, NO_DESCRIPTION, SHOWN_FOOTER, CUT_POINTER,
} = summaryMod;
const screenMod = H.load('lib/work-order-text-screen.js');

const runner = K.makeRunner('Work Order Alert description block - integration tests (no AI)');
const { test } = runner;

const HELD_ONLY = [HEADER, HELD_NOTICE];
const UNASSIGNED_ONLY = [HEADER, UNASSIGNED_NOTICE];
const unassignedScenario = SCENARIOS.find((x) => x.name === 'unassigned-pod-two-recipients');

/** Runs a job object (not cloned, so a Proxy survives) through the real alert code. */
async function sendRaw({ mode = 'on', job, property = baseProperty(), before } = {}) {
  H.reset();
  if (mode) process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = mode;
  if (mode === 'on') process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
  H.db.tables.properties.push(clone(property));
  if (before) before();
  const result = await alert.handleWorkOrderJob(job, 'webhook');
  return { result, email: H.mail.sent[0] || null, count: H.mail.sent.length };
}

// ════════════════════════════════════════════════════════════════════════
// A. BYTE-IDENTICAL PROOF AGAINST THE PARENT COMMIT'S OUTPUT, AND THE MODES
// ════════════════════════════════════════════════════════════════════════
test('A1 golden fixture covers every scenario (captured from parent 058618d)', async () => {
  assert.deepStrictEqual(K.golden.map((g) => g.name).sort(), SCENARIOS.map((s) => s.name).sort());
  assert.ok(K.golden.length >= 10);
});

test('A2 mode unset: every scenario is byte-identical to the parent output, no new work done', async () => {
  for (const s of SCENARIOS) {
    const r = await send({ mode: null, job: s.job, property: s.property, before: () => { H.latchelState.getJobImpl = async () => baseJob(); } });
    assertIdenticalToGolden(r.email, s.name);
    assert.strictEqual(H.ai.constructed, 0, `${s.name}: no model client in mode off`);
    assert.strictEqual(H.latchelState.getJobCalls.length, 0, `${s.name}: mode off must make no Latchel call`);
    assert.strictEqual(auditEvents(DESC_ACTION).length, 0, `${s.name}: mode off must write no description audit event`);
  }
});

test('A3 mode "off" explicitly: byte-identical (kill switch)', async () => {
  for (const s of SCENARIOS) {
    const r = await send({ mode: 'off', job: s.job, property: s.property });
    assertIdenticalToGolden(r.email, s.name);
  }
});

test('A4 any unrecognized mode value means off (never on)', async () => {
  for (const v of ['ON', 'On', 'true', '1', 'yes', 'enabled', ' on', 'on ', 'shadow ', 'Shadow', 'SHADOW', 'false', '0', 'x']) {
    const s = SCENARIOS.find((x) => x.name === 'job-without-free-text-fields');
    const r = await send({ mode: v, job: s.job, property: s.property });
    assertIdenticalToGolden(r.email, s.name);
    assert.strictEqual(descriptionMode(), 'off', `value ${JSON.stringify(v)} must resolve to off`);
    assert.strictEqual(H.latchelState.getJobCalls.length, 0, `value ${JSON.stringify(v)} must not trigger the Latchel fallback`);
    assert.strictEqual(auditEvents(DESC_ACTION).length, 0);
  }
  H.reset();
  assert.strictEqual(descriptionMode(), 'off', 'unset means off');
  process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'shadow'; assert.strictEqual(descriptionMode(), 'shadow');
  process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on';
  assert.strictEqual(descriptionMode(), 'shadow', '"on" without the interlock is shadow');
  process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
  assert.strictEqual(descriptionMode(), 'on');
});

test('A5 shadow mode: email byte-identical to parent for every scenario, but the local pipeline ran and was audited', async () => {
  for (const s of SCENARIOS) {
    const r = await send({ mode: 'shadow', job: s.job, property: s.property, before: () => { H.latchelState.getJobImpl = async () => baseJob(); } });
    assertIdenticalToGolden(r.email, s.name);
    assert.strictEqual(auditEvents(DESC_ACTION).length, 1, `${s.name}: shadow writes exactly one description audit event`);
  }
  const r = await send({ mode: 'shadow' });
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.result, 'shown');
  assert.ok(!r.email.text.includes('What the work order is'));
});

test('A6 mode on: only change is ONE contiguous inserted segment after "Created:"; subject, recipients, other lines identical', async () => {
  for (const s of SCENARIOS) {
    const r = await send({ mode: 'on', job: s.job, property: s.property, before: () => { H.latchelState.getJobImpl = async () => { throw new Error('lookup down'); }; } });
    const g = goldenByName.get(s.name);
    assert.strictEqual(r.email.subject, g.subject, `${s.name}: subject must not change`);
    assert.deepStrictEqual(r.email.to, g.to, `${s.name}: recipients must not change`);
    const gl = g.text.split('\n');
    const nl = r.email.text.split('\n');
    const i = gl.findIndex((l) => l.startsWith('Created:'));
    const k = nl.length - gl.length;
    assert.ok(k >= 2, `${s.name}: expected an inserted segment, got ${k} extra lines`);
    assert.deepStrictEqual(nl.slice(0, i + 1), gl.slice(0, i + 1), `${s.name}: lines up to and including Created: changed`);
    assert.deepStrictEqual(nl.slice(i + 1 + k), gl.slice(i + 1), `${s.name}: lines after the block changed`);
    const inserted = nl.slice(i + 1, i + 1 + k);
    assert.strictEqual(inserted[0], '', `${s.name}: block starts after a blank line`);
    assert.strictEqual(inserted[1].startsWith(HEADER), true, `${s.name}: block header`);
  }
});

test('A7 the ON interlock: "on" takes effect only with WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED exactly "yes"', async () => {
  for (const v of [undefined, 'no', 'YES', 'Yes', 'true', '1', ' yes', 'yes ', '']) {
    const r = await send({ mode: 'on', interlock: false, before: () => { if (v !== undefined) process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = v; } });
    assertIdenticalToGolden(r.email, 'normal-solimar');
    const ev = auditEvents(DESC_ACTION);
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].details.mode, 'shadow', `interlock ${JSON.stringify(v)}: recorded as shadow`);
    assert.strictEqual(ev[0].details.on_downgraded, true);
    assert.strictEqual(H.logs.filter((l) => l.includes('ingestion interlock is not set')).length, 1, 'exactly one constant log line per attempt');
  }
  let r = await send({ mode: 'on' });
  assert.ok(r.email.text.includes(HEADER), 'with the interlock the block is in the email');
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.on_downgraded, false);
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.mode, 'on');
  r = await send({ mode: 'shadow' });
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.on_downgraded, false);
  assert.strictEqual(descriptionModeInfo().mode, 'shadow');
});

test('A8 shadow output is byte-identical to off output for shown, held, hostile and empty texts', async () => {
  const texts = [
    ['Faucet', 'drips under the sink'], ['Visit', 'tenant uses a wheelchair'], ['x', 'paint the walls white'],
    ['', ''], ['<script>alert(1)</script>', 'http://evil.test/a javascript:alert(1)'],
    ['Entry', 'Habla espanol solamente'], ['A', 'B'.repeat(5000)], ['Fuga', 'el nino esta enfermo'],
  ];
  for (const [name, description] of texts) {
    const off = await send({ mode: null, job: baseJob({ name, description }) });
    const shadow = await send({ mode: 'shadow', job: baseJob({ name, description }) });
    assert.strictEqual(shadow.email.text, off.email.text);
    assert.strictEqual(shadow.email.subject, off.email.subject);
    assert.deepStrictEqual(shadow.email.to, off.email.to);
  }
});

// ════════════════════════════════════════════════════════════════════════
// B. WHAT THE BLOCK SAYS
// ════════════════════════════════════════════════════════════════════════
test('B1 shown: title, category guess, priority, description and the fixed last line, exact lines', async () => {
  const r = await send({ job: baseJob({ name: 'Leaking kitchen faucet', description: 'Faucet drips constantly under the sink since Monday morning.', is_urgent: true }) });
  assert.deepStrictEqual(blockLines(r.email.text), [
    HEADER,
    '  Title: Leaking kitchen faucet',
    '  Category (auto-sorted guess): Plumbing',
    '  Priority: Urgent (flagged in Latchel)',
    '  Description: "Faucet drips constantly under the sink since Monday morning."',
    '  (Quoted as typed in Latchel. Not checked for names, phone numbers or access codes. Internal use only.)',
  ]);
  assert.strictEqual(SHOWN_FOOTER, '  (Quoted as typed in Latchel. Not checked for names, phone numbers or access codes. Internal use only.)');
  assert.strictEqual(r.result.action, 'sent');
  const ev = auditEvents(DESC_ACTION)[0];
  assert.strictEqual(ev.details.result, 'shown');
  assert.strictEqual(ev.details.cause, null);
});

test('B2 everything the email said before is still there, in the same order and text', async () => {
  const r = await send({ job: baseJob({ name: 'Leaking kitchen faucet', description: 'Faucet drips under the sink.' }) });
  const g = goldenByName.get('normal-solimar');
  for (const line of g.text.split('\n').filter(Boolean)) assert.ok(r.email.text.includes(line), `missing original line: ${line}`);
  assert.strictEqual(r.email.subject, g.subject);
});

test('B3 title that is just the start of the description is not repeated', async () => {
  const r = await send({ job: baseJob({ name: 'Garbage disposal jammed', description: 'garbage disposal jammed and humming, will not turn' }) });
  const b = blockLines(r.email.text);
  assert.ok(!b.some((l) => l.startsWith('  Title:')), 'no Title line');
  assert.ok(b.some((l) => l.startsWith('  Description: "garbage disposal jammed and humming')));
});

test('B4 title only: description line says none was entered', async () => {
  const r = await send({ job: baseJob({ name: 'Replace hallway light bulb', description: null }) });
  assert.deepStrictEqual(blockLines(r.email.text).filter((l) => !l.includes('Category') && l !== SHOWN_FOOTER), [
    HEADER, '  Title: Replace hallway light bulb', `  Description: ${NO_DESCRIPTION}`,
  ]);
});

test('B5 description only: no Title line', async () => {
  const r = await send({ job: baseJob({ name: '', description: 'Back gate latch is loose.' }) });
  assert.ok(!blockLines(r.email.text).some((l) => l.startsWith('  Title:')));
  assert.ok(blockLines(r.email.text).some((l) => l === '  Description: "Back gate latch is loose."'));
});

test('B6 both missing (blank, whitespace, null, absent values) gives the one explanatory line and the screen is never asked', async () => {
  let asked = 0;
  summaryMod._setScreenForTesting(() => { asked++; return { status: 'cleared' }; });
  try {
    for (const [name, description] of [['', ''], ['   ', '\n\t '], [null, null], [undefined, null]]) {
      const r = await send({ job: baseJob({ name, description }) });
      assert.deepStrictEqual(blockLines(r.email.text), [K.summaryMod.NONE_LINE]);
      assert.strictEqual(auditEvents(DESC_ACTION)[0].details.result, 'none');
      assert.strictEqual(auditEvents(DESC_ACTION)[0].risk_level, 'low');
    }
  } finally { summaryMod._setScreenForTesting(null); }
  assert.strictEqual(asked, 0, 'nothing to check, nothing screened');
  assert.ok(NONE_LINE.endsWith('see Latchel)'));
});

test('B7 null/undefined count as missing; any other non-text value is held as a scanner error and never prints undefined/null/[object Object]', async () => {
  for (const v of [42, true, { a: 1 }, ['x', 'y'], 3.14]) {
    for (const job of [baseJob({ name: v, description: v }), baseJob({ name: 'Real title here', description: v }), baseJob({ name: v, description: 'Real description here.' })]) {
      const r = await send({ job });
      assert.deepStrictEqual(blockLines(r.email.text), HELD_ONLY, `non-text value ${JSON.stringify(v)} holds`);
      for (const l of blockLines(r.email.text)) assert.ok(!FORBIDDEN_WORDS.test(l), `bad text in block line: ${l}`);
      assert.strictEqual(auditEvents(DESC_ACTION)[0].details.cause, 'check_error');
    }
  }
  const direct = await prepareWorkOrderSummary({ name: NaN, description: 'fine text here' });
  assert.strictEqual(direct.status, 'held'); assert.strictEqual(direct.meta.cause, 'check_error');
});

test('B8 priority comes only from Latchel booleans', async () => {
  const cases = [
    [{ is_emergency: true, is_urgent: false }, '  Priority: Emergency (flagged in Latchel)'],
    [{ is_emergency: false, is_urgent: true }, '  Priority: Urgent (flagged in Latchel)'],
    [{ is_emergency: true, is_urgent: true }, '  Priority: Emergency / Urgent (flagged in Latchel)'],
    [{ is_emergency: false, is_urgent: false }, null],
    [{ is_emergency: 'true', is_urgent: 1 }, null], // not real booleans
  ];
  for (const [flags, expected] of cases) {
    const r = await send({ job: baseJob(Object.assign({ name: 'Broken window latch', description: 'Latch will not close.' }, flags)) });
    const p = blockLines(r.email.text).filter((l) => l.startsWith('  Priority:'));
    assert.deepStrictEqual(p, expected ? [expected] : []);
  }
  const r = await send({ job: baseJob({ name: 'URGENT EMERGENCY', description: 'This is an emergency and very urgent.' }) });
  assert.ok(!blockLines(r.email.text).some((l) => l.startsWith('  Priority:')), 'urgent wording in the text creates no priority line');
});

test('B9 category is a guess from the fixed list: none, "other" only, and at most two labels', async () => {
  let r = await send({ job: baseJob({ name: 'Question about the thing', description: 'Please advise on the thing.' }) });
  assert.ok(!blockLines(r.email.text).some((l) => l.includes('Category')), 'no match gives no category line');
  r = await send({ job: baseJob({ name: 'Refrigerator leaking, outlet sparking, roof tiles, mouse, new lock', description: 'Many problems here.' }) });
  const cat = blockLines(r.email.text).find((l) => l.includes('Category'));
  assert.ok(cat.startsWith('  Category (auto-sorted guess): '));
  const labels = cat.split(': ')[1].split(', ');
  assert.ok(labels.length <= 2, `at most two labels, got ${labels.length}`);
  const allowed = new Set(Object.values(require(path.resolve(H.HUB_DIR, 'maintenance-history/lib/component-categories')).CATEGORY_LABELS));
  for (const l of labels) assert.ok(allowed.has(l) && l !== 'Other', `label from the fixed list: ${l}`);
});

test('B10 long description is cut at a word boundary with " ..." and the short pointer to Latchel', async () => {
  const r = await send({ job: baseJob({ name: 'Long one', description: 'water '.repeat(1000).trim() }) });
  const d = blockLines(r.email.text).find((l) => l.startsWith('  Description:'));
  const quoted = d.slice('  Description: "'.length, d.indexOf(' ..."'));
  assert.ok(Array.from(quoted).length <= 300, 'description is at most 300 code points before the ellipsis');
  assert.strictEqual(quoted, 'water '.repeat(50).trim(), 'cut at the last whole word');
  assert.ok(d.endsWith(' ..." (shortened; full text is in Latchel)'), d.slice(-60));
  assert.strictEqual(CUT_POINTER, ' (shortened; full text is in Latchel)');
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.truncated, true);
});

test('B11 one 600-character unbroken word is hard-cut at 300', async () => {
  const r = await send({ job: baseJob({ name: 'Unbroken', description: 'x'.repeat(600) }) });
  const d = blockLines(r.email.text).find((l) => l.startsWith('  Description:'));
  assert.ok(d.includes(`"${'x'.repeat(300)} ..."`), 'exactly 300 x then " ..."');
  assert.ok(d.includes('(shortened'));
});

test('B12 an emoji at the cut point is never split (code points, not UTF-16 units)', async () => {
  const text = 'a'.repeat(299) + '\u{1F600}\u{1F600}\u{1F600}';
  const r = await send({ job: baseJob({ name: 'Emoji edge', description: text }) });
  const d = blockLines(r.email.text).find((l) => l.startsWith('  Description:'));
  assert.ok(d.includes(`${'a'.repeat(299)}\u{1F600} ..."`), 'one whole emoji kept, then the ellipsis');
  assert.strictEqual(hasLoneSurrogate(r.email.text), false);
  const t = truncate('b'.repeat(99) + '\u{1F600}\u{1F600}', 100);
  assert.strictEqual(hasLoneSurrogate(t.text), false);
  assert.ok(t.text.endsWith('\u{1F600} ...'));
});

test('B13 title longer than 100 is cut; short text is not touched', async () => {
  const r = await send({ job: baseJob({ name: 'T'.repeat(250), description: 'short' }) });
  const t = blockLines(r.email.text).find((l) => l.startsWith('  Title:'));
  assert.strictEqual(t, `  Title: ${'T'.repeat(100)} ...`);
  const r2 = await send({ job: baseJob({ name: 'Short title', description: 'Short description.' }) });
  assert.ok(!r2.email.text.includes(' ...'));
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.truncated, false);
});

test('B14 truncate(): word boundary only when it falls in the last quarter, else hard cut', async () => {
  assert.deepStrictEqual(truncate('aaaaa ' + 'b'.repeat(40), 20), { text: 'aaaaa ' + 'b'.repeat(14) + ' ...', cut: true });
  assert.deepStrictEqual(truncate('aaaaaaaaaaaaaaaa bbbbbbbbbb', 20), { text: 'aaaaaaaaaaaaaaaa ...', cut: true });
  assert.deepStrictEqual(truncate('short', 20), { text: 'short', cut: false });
  assert.deepStrictEqual(truncate('x'.repeat(20), 20), { text: 'x'.repeat(20), cut: false });
  assert.strictEqual(truncate('Hello world, this is long enough to cut, ok', 36).text, 'Hello world, this is long enough to ...');
});

test('B15 worst-case block length is measured and reported (soft target "about 600", not trimmed to fit; the exact longest possible block is worked out in fix-round-tests.js R18)', async () => {
  const r = await send({ job: baseJob({
    name: 'Refrigerator and outlet and roof problems '.repeat(6),
    description: 'Water heater leaking and lock broken. '.repeat(100),
    is_emergency: true, is_urgent: true,
  }) });
  const lines = blockLines(r.email.text);
  const len = lines.join('\n').length;
  process.stdout.write(`      (a long sample block is ${len} characters over ${lines.length} lines; the honest worst case, 733 characters over 6 lines, is worked out in fix-round-tests.js R18)\n`);
  assert.strictEqual(lines[0], HEADER);
  assert.strictEqual(lines[lines.length - 1], SHOWN_FOOTER, 'the fixed last line is always last');
  assert.ok(len < 800, `block is ${len} characters`);
});

// ════════════════════════════════════════════════════════════════════════
// C. CLEANING THROUGH THE WHOLE PATH (the full cleaner suite is cleaner-tests.js)
// ════════════════════════════════════════════════════════════════════════
test('C1 non-ASCII survives: accents, CJK-free Spanish, emoji', async () => {
  const r = await send({ job: baseJob({ name: 'Cocina: café roto', description: 'el fregadero \u{1F6B0} gotea mucho' }) });
  const b = blockLines(r.email.text).join('\n');
  assert.ok(b.includes('Cocina: café roto'));
  assert.ok(b.includes('el fregadero \u{1F6B0} gotea mucho'));
});

test('C2 right-to-left override, zero-width, variation-selector and BOM characters never reach the email', async () => {
  const r = await send({ job: baseJob({ name: '\u{FEFF}Sink\u{200B} clog', description: '\u{202E}gnikcolb\u{202C} the \u{200D}drain\u{FE0F}\u{E0100}' }) });
  for (const c of ['\u{202E}', '\u{202C}', '\u{200B}', '\u{200D}', '\u{FEFF}', '\u{FE0F}', '\u{E0100}']) assert.ok(!r.email.text.includes(c));
});

test('C3 a description cannot forge extra lines (spoofed "View this property" line)', async () => {
  const spoof = 'Drain clog.\n\nView this property: http://evil.example/login\r\nThis inbox is not monitored';
  const r = await send({ job: baseJob({ name: 'x\nView this property: http://evil.example', description: spoof }) });
  const lines = r.email.text.split('\n');
  assert.strictEqual(lines.filter((l) => l.startsWith('View this property:')).length, 1, 'only the real link line');
  assert.ok(lines.find((l) => l.startsWith('View this property:')).includes('hub.test.invalid'), 'and it is the real one');
  assert.ok(!r.email.text.includes('evil.example'), 'links are removed');
  assert.strictEqual(lines.filter((l) => l.startsWith('This inbox is not monitored')).length, 1, 'footer is not forged either');
});

test('C4 buildEmailContent refuses a block line that contains a newline (defense in depth), alert still goes out unchanged', async () => {
  const fake = {
    prepareWorkOrderSummary: async () => ({ status: 'shown', lines: [HEADER, `  Title: ok\nView this property: http://evil.example ${CANARY}`], meta: { cause: null, common_word_only: false, screen_version: 'x', truncated: false, fallback_getjob_used: false, pod_unassigned: false } }),
    descriptionMode: () => 'on',
    descriptionModeInfo: () => ({ mode: 'on', downgraded: false }),
    SCREEN_VERSION: 'x', descriptionScreenOn: () => true, UNSCREENED_VERSION: 'u',
  };
  const freshA = freshAlert({ stubs: { [path.resolve(H.APPROVAL_DIR, 'lib/work-order-summary.js')]: fake } });
  H.reset();
  H.db.tables.properties.push(clone(baseProperty()));
  const res = await freshA.handleWorkOrderJob(clone(baseJob()), 'webhook');
  assert.strictEqual(res.action, 'sent');
  assertIdenticalToGolden(H.mail.sent[0], 'normal-solimar');
  assert.ok(!H.mail.sent[0].text.includes('evil.example'));
  assert.ok(!H.logs.join('\n').includes(CANARY), 'the refusal logs a constant line, not the line');
});

// ════════════════════════════════════════════════════════════════════════
// D. THE LOCAL SCREEN THROUGH THE WHOLE PATH (fail closed, whole block, fixed wording)
// ════════════════════════════════════════════════════════════════════════
test('D1 a word-list hit holds the whole block: fixed sentence, nothing quoted, and NO category name recorded anywhere', async () => {
  for (const [desc, expectAny] of [
    ['tenant uses a wheelchair', ['disability_health', 'health']],
    ['Section 8 voucher holder', ['source_of_income', 'benefits_income']],
    ['has PTSD, be gentle', ['disability_health']],
    ['restraining order against the ex husband', ['safety_violence']],
    ['su hijo esta enfermo', ['minors', 'health']],
  ]) {
    const r = await send({ job: baseJob({ name: 'Visit', description: `${CANARY} ${desc}` }) });
    assert.deepStrictEqual(blockLines(r.email.text), HELD_ONLY, `held block for: ${desc}`);
    assert.ok(!r.email.text.includes(CANARY), 'text must not be in the email');
    assert.strictEqual(r.result.action, 'sent', 'the alert itself still goes out');
    const ev = auditEvents(DESC_ACTION)[0];
    assert.strictEqual(ev.details.result, 'held');
    assert.strictEqual(ev.details.cause, 'local_screen');
    assert.ok(!('held_categories' in ev.details), `no category list is recorded for: ${desc}`);
    assert.ok(expectAny.every((c) => !JSON.stringify(auditEvents()).includes(c)), `no category name is recorded anywhere for: ${desc}`);
  }
});

test('D2 a hit in the TITLE or the DESCRIPTION withholds both', async () => {
  let r = await send({ job: baseJob({ name: 'Tenant is pregnant', description: 'Faucet drips under the sink.' }) });
  assert.deepStrictEqual(blockLines(r.email.text), HELD_ONLY);
  assert.ok(!r.email.text.includes('Faucet drips'));
  r = await send({ job: baseJob({ name: 'Leaking faucet', description: 'Tenant is pregnant, call first.' }) });
  assert.deepStrictEqual(blockLines(r.email.text), HELD_ONLY);
  assert.ok(!r.email.text.includes('Leaking faucet'));
});

test('D3 the held block is byte-identical across texts and across every cause (hit, scanner error, summary error)', async () => {
  const emails = [];
  const hold = async (label, jobOver, setup, teardown) => {
    try {
      const r = await send({ job: baseJob(jobOver), before: setup });
      assert.deepStrictEqual(blockLines(r.email.text), HELD_ONLY, label);
      emails.push({ label, text: r.email.text, event: auditEvents(DESC_ACTION)[0].details });
    } finally { if (teardown) teardown(); }
  };
  await hold('hit A', { name: 'Visit', description: 'tenant uses a wheelchair' });
  await hold('hit B (different text)', { name: 'Totally different', description: 'Section 8 voucher and a restraining order' });
  await hold('ordinary word', { name: 'Paint', description: 'paint the walls white' });
  await hold('screen throws', { name: 'Faucet', description: 'drips' }, () => summaryMod._setScreenForTesting(() => { throw new Error(CANARY); }), () => summaryMod._setScreenForTesting(null));
  await hold('screen returns garbage', { name: 'Faucet', description: 'drips' }, () => summaryMod._setScreenForTesting(() => 'nope'), () => summaryMod._setScreenForTesting(null));
  await hold('screen says cleared-but-broken status', { name: 'Faucet', description: 'drips' }, () => summaryMod._setScreenForTesting(() => ({ status: 'maybe' })), () => summaryMod._setScreenForTesting(null));
  await hold('cleaner rejects a non-text field', { name: 42, description: 'drips' });
  const proxy = new Proxy(baseJob({ name: 'Faucet', description: 'drips' }), {
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'description') throw new Error(`proxy blew up ${CANARY}`);
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
  const viaProxy = await sendRaw({ job: proxy });
  assert.deepStrictEqual(blockLines(viaProxy.email.text), HELD_ONLY, 'summary_error');
  emails.push({ label: 'summary_error', text: viaProxy.email.text, event: auditEvents(DESC_ACTION)[0].details });

  for (const e of emails) assert.strictEqual(e.text, emails[0].text, `${e.label}: whole email is byte-identical to the first held email`);
  const causes = emails.map((e) => e.event.cause);
  assert.deepStrictEqual(causes, ['local_screen', 'local_screen', 'local_screen', 'check_error', 'check_error', 'check_error', 'check_error', 'summary_error']);
  assert.ok(!H.logs.join('\n').includes(CANARY));
});

test('D4 a held or unassigned block has no category line, no priority line and no byte derived from the text', async () => {
  const r = await send({ job: baseJob({ name: 'Faucet leak', description: 'tenant uses a wheelchair, faucet drips under the sink', is_emergency: true, is_urgent: true }) });
  const b = blockLines(r.email.text);
  assert.deepStrictEqual(b, HELD_ONLY);
  assert.ok(!r.email.text.includes('Category') && !r.email.text.includes('Priority') && !r.email.text.includes('Plumbing'));
  assert.ok(HELD_NOTICE.includes('Latchel job and ticket number') && !/held for privacy review/i.test(HELD_NOTICE));
  assert.ok(!/privacy review/i.test(UNASSIGNED_NOTICE));
  const src = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-summary.js'), 'utf8');
  assert.ok(!/held for privacy review/i.test(src), 'the retired phrase is gone from the code');
});

test('D5 ordinary words hold like any other term (white, black, blind, diagnosis, church ...), with no rescue and no model', async () => {
  H.setDummyAiEnv(); // even with every switch that could enable an AI path turned on
  for (const text of ['Paint the walls white', 'black mold on the ceiling', 'replace the blind in the bedroom', 'diagnosis: bad capacitor', 'diagnosed the leak at the church', 'too old to repair', 'the temple street gate']) {
    const r = await send({ job: baseJob({ name: 'Paint', description: text }), before: () => H.setDummyAiEnv() });
    assert.deepStrictEqual(blockLines(r.email.text), HELD_ONLY, `held: ${text}`);
    const ev = auditEvents(DESC_ACTION)[0].details;
    assert.strictEqual(ev.common_word_only, true, `only ordinary words: ${text}`);
    assert.strictEqual(H.ai.constructed, 0);
  }
  const r = await send({ job: baseJob({ name: 'Blinds', description: 'Replace the bedroom blinds' }) });
  assert.ok(blockLines(r.email.text).some((l) => l.includes('Replace the bedroom blinds')), 'plural "blinds" is a different word and passes');
  const mixed = await send({ job: baseJob({ name: 'Paint', description: 'paint the walls white, tenant is pregnant' }) });
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.common_word_only, false, 'a sensitive word next to an ordinary one is not "common only"');
  assert.ok(mixed.email);
});

test('D6 unassigned pod: its own fixed sentence, both inboxes, one task, and the text is never read, screened or fetched', async () => {
  const reads = [];
  const handler = {
    get(target, prop) { reads.push(String(prop)); return Reflect.get(target, prop); },
    getOwnPropertyDescriptor(target, prop) { reads.push(`desc:${String(prop)}`); return Reflect.getOwnPropertyDescriptor(target, prop); },
  };
  let screened = 0;
  summaryMod._setScreenForTesting(() => { screened++; return { status: 'cleared' }; });
  try {
    const job = new Proxy(clone(unassignedScenario.job), handler);
    const r = await sendRaw({ job, property: unassignedScenario.property, before: () => { H.latchelState.getJobImpl = async () => baseJob(); summaryMod._setScreenForTesting(() => { screened++; return { status: 'cleared' }; }); } });
    assert.deepStrictEqual(blockLines(r.email.text), UNASSIGNED_ONLY);
    assert.deepStrictEqual(r.email.to.slice().sort(), ['faria-pod@example.test', 'solimar-pod@example.test']);
    assert.strictEqual(screened, 0, 'the screen is not asked');
    assert.strictEqual(H.latchelState.getJobCalls.length, 0, 'getJob is not called');
    for (const k of ['name', 'description', 'is_emergency', 'is_urgent', 'desc:description']) assert.ok(!reads.includes(k), `the text field ${k} was never read`);
    assert.strictEqual(H.db.writes.filter((w) => w.table === 'tasks' && w.op === 'insert').length, 1);
    const ev = auditEvents(DESC_ACTION)[0];
    assert.strictEqual(ev.details.result, 'held'); assert.strictEqual(ev.details.cause, 'pod_unassigned');
    assert.strictEqual(ev.details.pod_unassigned, true); assert.ok(!('held_categories' in ev.details));
    assert.strictEqual(ev.risk_level, 'low');
  } finally { summaryMod._setScreenForTesting(null); }
  assert.notStrictEqual(UNASSIGNED_NOTICE, HELD_NOTICE);
  assert.ok(UNASSIGNED_NOTICE.includes('no pod assigned yet'));
  assert.strictEqual(UNASSIGNED_NOTICE, '  The title and description are not included because this property has no pod assigned yet. Open the Latchel job and ticket number listed above to read them.');
  assert.strictEqual(HELD_NOTICE, '  The title and description are not included in this email. Open the Latchel job and ticket number listed above to read them.');
});

test('D7 the screen throwing never stops the alert; it is held with cause check_error and audited as medium', async () => {
  summaryMod._setScreenForTesting(() => { throw new Error(`explode ${CANARY}`); });
  try {
    const r = await send({ job: baseJob({ name: 'Faucet', description: 'drips' }), before: () => summaryMod._setScreenForTesting(() => { throw new Error(`explode ${CANARY}`); }) });
    assert.strictEqual(r.result.action, 'sent');
    assert.deepStrictEqual(blockLines(r.email.text), HELD_ONLY);
    const ev = auditEvents(DESC_ACTION)[0];
    assert.strictEqual(ev.details.cause, 'check_error'); assert.strictEqual(ev.risk_level, 'medium');
    assert.ok(!H.logs.join('\n').includes(CANARY));
  } finally { summaryMod._setScreenForTesting(null); }
});

test('D8 a failed start-up self-test makes every call a scanner error: held / check_error, recorded, alert still sent', async () => {
  const termsPath = path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-screen-terms.js');
  const realTerms = require(termsPath);
  // A broken list: the whole health category has been deleted.
  const broken = Object.assign({}, realTerms, { TERMS: Object.assign({}, realTerms.TERMS, { health: [] }) });
  const brokenScreen = H.loadFresh({
    target: path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-screen.js'),
    evict: [path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-screen.js')],
    stubs: { [termsPath]: broken },
  });
  assert.strictEqual(brokenScreen._internals.selfTestStatus().ok, false);
  assert.ok(H.logs.filter((l) => l.includes('self-test FAILED')).length === 1, 'exactly one constant line logged');
  for (const text of ['replace the faucet', 'tenant uses a wheelchair']) {
    const v = brokenScreen.screenWorkOrderText({ title: 'x', description: text });
    assert.strictEqual(v.status, 'held'); assert.strictEqual(v.cause, 'check_error');
  }
  const r = await send({ mode: 'shadow', job: baseJob({ name: 'Faucet', description: 'drips' }), before: () => summaryMod._setScreenForTesting(brokenScreen.screenWorkOrderText) });
  summaryMod._setScreenForTesting(null);
  assert.strictEqual(r.result.action, 'sent');
  const ev = auditEvents(DESC_ACTION)[0].details;
  assert.strictEqual(ev.result, 'held'); assert.strictEqual(ev.cause, 'check_error');
});

test('D8b whatever categories a screen returns (even a hostile list) are never read: nothing about them is recorded, logged or put in the email', async () => {
  const rogue = () => ({ status: 'held', cause: 'local_screen', categories: [`tenant has cancer ${CANARY}`, 'health', 42, null, 'made_up_category', 'minors'], common_word_only: true, screen_version: 'x-version' });
  const r = await send({ job: baseJob({ name: 'Faucet', description: 'drips' }), before: () => summaryMod._setScreenForTesting(rogue) });
  summaryMod._setScreenForTesting(null);
  const ev = auditEvents(DESC_ACTION)[0].details;
  assert.ok(!('held_categories' in ev), 'no category key');
  const everything = JSON.stringify([auditEvents(), H.db.writes, H.logs, r.email]);
  assert.ok(!everything.includes(CANARY));
  for (const name of screenMod.CATEGORY_VOCABULARY) assert.ok(!everything.includes(`"${name}"`), `a category name (${name}) was recorded or logged as a value`);
  assert.strictEqual(ev.screen_version, 'x-version');
  assert.strictEqual(ev.common_word_only, true);
  assert.deepStrictEqual(blockLines(r.email.text), HELD_ONLY);
});

test('D9 text in a script the word lists cannot read is held (unscreenable_language)', async () => {
  const r = await send({ job: baseJob({ name: 'Plumbing', description: 'Вода течет под раковиной' }) });
  assert.deepStrictEqual(blockLines(r.email.text), HELD_ONLY);
  assert.ok(!('held_categories' in auditEvents(DESC_ACTION)[0].details));
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.cause, 'local_screen');
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.common_word_only, false);
});

// ════════════════════════════════════════════════════════════════════════
// E. THE LATCHEL FALLBACK (description key absent)
// ════════════════════════════════════════════════════════════════════════
const noDescKey = () => { const j = baseJob({ job_id: 5001 }); delete j.description; return j; };

test('E1 description key absent: exactly one read-only getJob, and its fields are used', async () => {
  const r = await send({ job: noDescKey(), before: () => { H.latchelState.getJobImpl = async () => ({ job_id: 5001, name: 'Detail title', description: 'Detail says the sink is clogged.', is_emergency: true }); } });
  assert.deepStrictEqual(H.latchelState.getJobCalls, ['5001']);
  const b = blockLines(r.email.text);
  assert.ok(b.includes('  Title: Detail title'));
  assert.ok(b.includes('  Description: "Detail says the sink is clogged."'));
  assert.ok(b.includes('  Priority: Emergency (flagged in Latchel)'));
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.fallback_getjob_used, true);
});

test('E2 getJob fails (throws, null, not an object): neutral line, alert still sent, nothing logged from the error', async () => {
  const impls = [
    async () => { throw new Error(`upstream body ${CANARY}`); },
    async () => null,
    async () => 'a string',
  ];
  for (const impl of impls) {
    const r = await send({ job: noDescKey(), before: () => { H.latchelState.getJobImpl = impl; } });
    assert.deepStrictEqual(blockLines(r.email.text), [UNAVAILABLE_LINE]);
    assert.strictEqual(r.result.action, 'sent');
    assert.strictEqual(auditEvents(DESC_ACTION)[0].details.result, 'unavailable');
    assert.strictEqual(auditEvents(DESC_ACTION)[0].risk_level, 'medium');
    assert.ok(!everythingExceptBody(r.email).includes(CANARY), 'the lookup error text is never logged');
  }
  H.reset();
  const s = await prepareWorkOrderSummary({ name: 'x' }, { jobId: '1', fetchJob: () => new Promise(() => {}), fetchTimeoutMs: 30 });
  assert.strictEqual(s.status, 'unavailable');
});

test('E3 description present but null/empty: no lookup', async () => {
  for (const d of [null, '', '   ']) {
    await send({ job: baseJob({ description: d, name: 'Has a title' }), before: () => { H.latchelState.getJobImpl = async () => baseJob(); } });
    assert.strictEqual(H.latchelState.getJobCalls.length, 0);
  }
});

test('E4 the lookup happens only after the property, notes and dedup gates pass, and never when off', async () => {
  const lookup = () => { H.latchelState.getJobImpl = async () => baseJob(); };
  await send({ job: noDescKey(), property: baseProperty({ maintenance_notes: '   ' }), before: lookup });
  assert.strictEqual(H.latchelState.getJobCalls.length, 0, 'no notes: no lookup');
  await send({ job: Object.assign(noDescKey(), { property_id: 777777 }), before: lookup });
  assert.strictEqual(H.latchelState.getJobCalls.length, 0, 'unresolved property: no lookup');
  await send({ job: noDescKey(), before: () => { lookup(); H.db.tables.work_order_note_alerts.push({ latchel_job_id: '5001', send_status: 'sent' }); } });
  assert.strictEqual(H.latchelState.getJobCalls.length, 0, 'already sent: no lookup');
  await send({ mode: 'off', job: noDescKey(), before: lookup });
  assert.strictEqual(H.latchelState.getJobCalls.length, 0, 'mode off: no lookup');
  await send({ job: noDescKey(), before: lookup });
  assert.strictEqual(H.latchelState.getJobCalls.length, 1, 'all gates pass: exactly one lookup');
});

// ════════════════════════════════════════════════════════════════════════
// F. AUDIT EVENT (counts only)
// ════════════════════════════════════════════════════════════════════════
const ALLOWED_AUDIT_KEYS = [
  'latchel_job_id', 'trigger_source', 'mode', 'result', 'cause', 'common_word_only',
  'screen_version', 'truncated', 'fallback_getjob_used', 'pod_unassigned', 'on_downgraded', 'trace',
];
const RESULTS = ['shown', 'held', 'none', 'unavailable'];
const CAUSES = [null, 'local_screen', 'link_shape', 'pod_unassigned', 'check_error', 'unsettled_text', 'summary_error'];

function assertAuditDetailsShape(d) {
  const vocab = new Set(screenMod.CATEGORY_VOCABULARY);
  for (const k of Object.keys(d)) assert.ok(ALLOWED_AUDIT_KEYS.includes(k), `unexpected audit key: ${k}`);
  assert.deepStrictEqual(Object.keys(d).sort(), ALLOWED_AUDIT_KEYS.slice().sort(), 'every agreed key and no other');
  assert.strictEqual(typeof d.latchel_job_id, 'string');
  assert.ok(['webhook', 'reconciliation_poll'].includes(d.trigger_source));
  assert.ok(['shadow', 'on'].includes(d.mode));
  assert.ok(RESULTS.includes(d.result)); assert.ok(CAUSES.includes(d.cause));
  assert.ok(!('held_categories' in d), 'no category names are recorded (Peter\'s rule: no protected-class data in any table)');
  for (const v of Object.values(d)) assert.ok(typeof v !== 'string' || !vocab.has(v), 'no value is a category name');
  for (const k of ['common_word_only', 'truncated', 'fallback_getjob_used', 'pod_unassigned', 'on_downgraded']) assert.strictEqual(typeof d[k], 'boolean', k);
  assert.strictEqual(typeof d.screen_version, 'string');
  assert.deepStrictEqual(Object.keys(d.trace).sort(), ['parent_span_id', 'span_id', 'trace_id']);
}

test('F1 one Rule-1 audit event per attempt in shadow and on, with exactly the agreed counts-only keys', async () => {
  const r = await send({ job: baseJob({ name: 'Leaking faucet', description: 'drips' }) });
  const events = auditEvents(DESC_ACTION);
  assert.strictEqual(events.length, 1);
  const e = events[0];
  assert.strictEqual(e.entity_type, 'property'); assert.strictEqual(e.entity_id, 'prop-0001');
  assert.strictEqual(e.actor_type, 'system'); assert.strictEqual(e.actor_id, 'work-order-notes-alert');
  assert.strictEqual(e.privacy_category, 'processing'); assert.strictEqual(e.risk_level, 'low');
  assertAuditDetailsShape(e.details);
  assert.strictEqual(e.details.mode, 'on'); assert.strictEqual(e.details.trigger_source, 'webhook');
  assert.strictEqual(e.details.screen_version, 'protected-class-terms-v2+wo-supp-v4');
  for (const gone of ['matched_layer', 'terms_version', K.RETIRED_AI_WORDS[1]]) assert.ok(!(gone in e.details), `${gone} is no longer recorded`);
  assert.ok(r.email);
});

test('F2 the key set and value types hold for every kind of outcome', async () => {
  const outcomes = [
    { job: baseJob({ name: 'Leaking faucet', description: 'drips' }) },
    { job: baseJob({ name: 'Visit', description: 'tenant uses a wheelchair and is afraid of her ex husband' }) },
    { job: baseJob({ name: '', description: '' }) },
    { job: noDescKey(), before: () => { H.latchelState.getJobImpl = async () => null; } },
    { job: unassignedScenario.job, property: unassignedScenario.property },
    { job: baseJob({ name: 42 }) },
    { mode: 'shadow', job: baseJob({ name: 'Paint', description: 'white' }) },
    { mode: 'on', interlock: false, job: baseJob({ name: 'x', description: 'y' }) },
  ];
  for (const o of outcomes) {
    await send(o);
    assertAuditDetailsShape(auditEvents(DESC_ACTION)[0].details);
  }
});

test('F3 risk level: medium for a hold (except pod_unassigned), unavailable and any error; low otherwise', async () => {
  const risk = async (o) => { await send(o); return auditEvents(DESC_ACTION)[0].risk_level; };
  assert.strictEqual(await risk({ job: baseJob({ name: 'Visit', description: 'tenant uses a wheelchair' }) }), 'medium');
  assert.strictEqual(await risk({ job: baseJob({ name: 'Paint', description: 'white' }) }), 'medium');
  assert.strictEqual(await risk({ job: baseJob({ name: 42 }) }), 'medium', 'check_error');
  assert.strictEqual(await risk({ job: noDescKey(), before: () => { H.latchelState.getJobImpl = async () => null; } }), 'medium', 'unavailable');
  assert.strictEqual(await risk({ job: baseJob({ name: '', description: '' }) }), 'low', 'none');
  assert.strictEqual(await risk({ job: baseJob({ name: 'Faucet', description: 'drips' }) }), 'low', 'shown');
  assert.strictEqual(await risk({ job: unassignedScenario.job, property: unassignedScenario.property }), 'low', 'pod_unassigned');
  const proxy = new Proxy(baseJob(), { getOwnPropertyDescriptor(t, p) { if (p === 'description') throw new Error('x'); return Reflect.getOwnPropertyDescriptor(t, p); } });
  await sendRaw({ job: proxy });
  assert.strictEqual(auditEvents(DESC_ACTION)[0].risk_level, 'medium', 'summary_error');
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.cause, 'summary_error');
});

test('F4 the audit event never contains text, a matched word, a length, a hash or a per-term count', async () => {
  const r = await send({ job: baseJob({ name: `${CANARY} Visit`, description: `${CANARY} tenant uses a wheelchair, Section 8, PTSD, white paint` }) });
  const blob = JSON.stringify(auditEvents());
  for (const bad of [CANARY, 'wheelchair', 'Section 8', 'section 8', 'PTSD', 'ptsd', 'white', 'Visit', 'length', 'hash', 'excerpt', 'term_count', 'matched']) {
    assert.ok(!blob.includes(bad), `audit contains: ${bad}`);
  }
  assert.ok(r.email);
});

test('F5 existing triggered / sent / failed events are unchanged', async () => {
  let r = await send({ mode: null });
  assert.deepStrictEqual(auditEvents().map((e) => e.action), ['work_order_note_alert.triggered', 'work_order_note_alert.sent']);
  r = await send({ mode: 'on' });
  assert.deepStrictEqual(auditEvents().map((e) => e.action), ['work_order_note_alert.triggered', DESC_ACTION, 'work_order_note_alert.sent']);
  assert.deepStrictEqual(Object.keys(auditEvents('work_order_note_alert.sent')[0].details).sort(), ['latchel_job_id', 'pod', 'property_id', 'recipients', 'trace']);
  r = await send({ mode: 'on', before: () => { H.mail.nextResult = { ok: false, sent: 0, failed: 1, accepted: [], rejected: [], error: 'mailer_not_configured' }; } });
  assert.deepStrictEqual(auditEvents('work_order_note_alert.send_failed')[0].details.error, 'mailer_not_configured');
  assert.strictEqual(auditEvents('work_order_note_alert.send_failed')[0].risk_level, 'high');
});

test('F6 work_order_note_alerts.flagged_protected_class / flagged_category stay FALSE / NULL even for held job text', async () => {
  for (const d of ['tenant uses a wheelchair', 'paint the walls white', 'drips']) {
    await send({ job: baseJob({ name: 'Visit', description: d }) });
    const row = H.db.writes.find((w) => w.table === 'work_order_note_alerts').payload;
    assert.strictEqual(row.flagged_protected_class, false); assert.strictEqual(row.flagged_category, null);
  }
});

// ════════════════════════════════════════════════════════════════════════
// G. NOTHING IS STORED, LOGGED OR LEAKED (canary)
// ════════════════════════════════════════════════════════════════════════
const canaryJob = (over) => baseJob(Object.assign({ name: `Broken ${CANARY} faucet`, description: `${CANARY} drips under the sink` }, over));

/** The canary must be nowhere except (optionally) the body of the sent email. */
function assertNoCanaryOutsideBody(email, label, result) {
  assert.ok(!everythingExceptBody(email).includes(CANARY), `${label}: canary found in subject / DB writes / logs / failure email`);
  if (result) assert.ok(!JSON.stringify(result).includes(CANARY), `${label}: canary found in the returned result`);
}

test('G1 shown: the canary is in the email body only; subject, rows, audit, tasks, logs and the failure email never have it', async () => {
  const r = await send({ job: canaryJob() });
  assert.ok(r.email.text.includes(CANARY), 'shown text is in the body');
  assertNoCanaryOutsideBody(r.email, 'shown', r.result);
  assert.strictEqual(r.email.subject, goldenByName.get('normal-solimar').subject, 'subject unchanged');
  const row = H.db.writes.find((w) => w.table === 'work_order_note_alerts');
  assert.strictEqual(row.payload.notes_snapshot, baseProperty().maintenance_notes, 'notes_snapshot is the notes only');
});

test('G2 shadow: the canary is not in the email at all, and nowhere else either', async () => {
  const r = await send({ mode: 'shadow', job: canaryJob() });
  assert.ok(!r.email.text.includes(CANARY));
  assertNoCanaryOutsideBody(r.email, 'shadow', r.result);
});

test('G3 held (word hit, ordinary word, scanner error): the canary is absent from the body and everywhere else', async () => {
  const variants = [
    { job: canaryJob({ description: `${CANARY} tenant uses a wheelchair` }) },
    { job: canaryJob({ description: `${CANARY} paint it white` }) },
    { job: canaryJob(), before: () => summaryMod._setScreenForTesting(() => { throw new Error(`screen ${CANARY}`); }) },
  ];
  for (const v of variants) {
    try {
      const r = await send(v);
      assert.ok(!r.email.text.includes(CANARY), 'held: body has no text');
      assertNoCanaryOutsideBody(r.email, 'held', r.result);
    } finally { summaryMod._setScreenForTesting(null); }
  }
});

test('G4 unavailable and unassigned-pod forms also carry no text', async () => {
  let r = await send({ job: (() => { const j = canaryJob(); delete j.description; return j; })(), before: () => { H.latchelState.getJobImpl = async () => { throw new Error(CANARY); }; } });
  assert.ok(!r.email.text.includes(CANARY)); assertNoCanaryOutsideBody(r.email, 'unavailable', r.result);
  r = await send({ job: Object.assign(clone(unassignedScenario.job), { name: CANARY, description: CANARY }), property: unassignedScenario.property });
  assert.ok(!r.email.text.includes(CANARY)); assertNoCanaryOutsideBody(r.email, 'unassigned', r.result);
});

test('G5 failure email to Peter is content-free and unchanged, in every mode', async () => {
  const expected = [
    'The Work Order Notes Alert for 123 Test Street Unit A failed to send.',
    '',
    'Work order: Ticket #7001 (Latchel job 5001)',
    'Intended pod / recipients: Solimar (solimar-pod@example.test)',
    'Error: mailer_not_configured',
    '',
    'This will be retried automatically on the next hourly backstop poll (or the next webhook delivery for the same work order) — no action needed unless it keeps failing.',
  ].join('\n');
  for (const mode of [null, 'shadow', 'on']) {
    const r = await send({ mode, job: canaryJob(), before: () => {
      H.mail.nextResult = { ok: false, sent: 0, failed: 1, accepted: [], rejected: [], error: 'mailer_not_configured' };
      process.env.GMAIL_USER = 'fake-sender@example.test';
      process.env.GMAIL_APP_PASSWORD = 'fake-app-password';
    } });
    assert.strictEqual(r.result.action, 'failed');
    assert.strictEqual(H.nm.created, 1, 'the (stubbed) independent channel was used');
    assert.strictEqual(H.nm.sent[0].text, expected, `failure email text unchanged (mode ${mode})`);
    assert.strictEqual(H.nm.sent[0].subject, 'Work Order Notes Alert failed to send — 123 Test Street Unit A');
    assertNoCanaryOutsideBody(r.email, `failure email (${mode})`, r.result);
  }
});

test('G6 FAILURES AT EVERY STAGE: the canary never reaches a log line, an error message, the result, a database write, the failure email or an outbound call', async () => {
  const lib = (f) => path.resolve(H.APPROVAL_DIR, 'lib', f);
  const cleanMod = H.load('lib/work-order-text-clean.js');
  const catPath = path.resolve(H.HUB_DIR, 'maintenance-history/lib/component-categories.js');
  const realCat = require(catPath);
  const stages = {
    cleaner: async () => {
      const a = freshAlert({ stubs: { [lib('work-order-text-clean.js')]: Object.assign({}, cleanMod, { cleanTextBoth() { throw new Error(`cleaner ${CANARY}`); } }) } });
      return run(a);
    },
    screen: async () => run(alert, () => summaryMod._setScreenForTesting(() => { throw new Error(`screen ${CANARY}`); })),
    truncate: async () => {
      const orig = Array.from;
      Array.from = function patched(x, ...rest) { if (typeof x === 'string' && x.includes(CANARY)) throw new Error(`truncate ${x}`); return orig.call(this, x, ...rest); };
      try { return await run(alert); } finally { Array.from = orig; }
    },
    categorize: async () => {
      const a = freshAlert({ stubs: { [catPath]: Object.assign({}, realCat, { categorize() { throw new Error(`categorize ${CANARY}`); } }) } });
      return run(a);
    },
    fetchJob: async () => run(alert, () => { H.latchelState.getJobImpl = async () => { throw new Error(`getJob ${CANARY}`); }; }, (j) => { delete j.description; }),
    audit_writer_throws: async () => run(alert, () => { H.db.throwOnInsert = (t, p) => t === 'audit_log' && p.action === DESC_ACTION; }),
    audit_writer_error_message: async () => run(alert, () => { H.db.errorOnInsert = (t, p) => (t === 'audit_log' && p.action === DESC_ACTION ? `db said ${CANARY}` : null); }),
    buildEmailContent: async () => {
      const fake = {
        prepareWorkOrderSummary: async () => ({ status: 'shown', lines: [HEADER, `  Title: a\nb ${CANARY}`], meta: { cause: null, common_word_only: false, screen_version: 'x', truncated: false, fallback_getjob_used: false, pod_unassigned: false } }),
        descriptionMode: () => 'on', descriptionModeInfo: () => ({ mode: 'on', downgraded: false }), SCREEN_VERSION: 'x', descriptionScreenOn: () => true, UNSCREENED_VERSION: 'u',
      };
      return run(freshAlert({ stubs: { [lib('work-order-summary.js')]: fake } }));
    },
    summary_throws: async () => {
      const fake = { prepareWorkOrderSummary: async () => { throw new Error(`summary ${CANARY}`); }, descriptionMode: () => 'on', descriptionModeInfo: () => ({ mode: 'on', downgraded: false }), SCREEN_VERSION: 'x', descriptionScreenOn: () => true, UNSCREENED_VERSION: 'u' };
      return run(freshAlert({ stubs: { [lib('work-order-summary.js')]: fake } }));
    },
    sendMail_throws: async () => run(alert, () => { H.mail.throwNext = (body) => new Error(`mail ${CANARY} ${body}`); }),
    sendMail_returns_error_echoing_body: async () => run(alert, () => { H.mail.nextResult = (body) => ({ ok: false, sent: 0, failed: 1, accepted: [], rejected: [], error: `rejected: ${body}` }); }, null, { gmail: true }),
    proxy_blows_up: async () => {
      const job = new Proxy(canaryJob(), { getOwnPropertyDescriptor(t, p) { if (p === 'description') throw new Error(`proxy ${CANARY}`); return Reflect.getOwnPropertyDescriptor(t, p); } });
      H.reset(); process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on'; process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
      H.db.tables.properties.push(clone(baseProperty()));
      const result = await alert.handleWorkOrderJob(job, 'webhook');
      return { result, thrown: null };
    },
  };

  async function run(a, setup, jobEdit, opts = {}) {
    H.reset();
    process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on';
    process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
    if (opts.gmail) { process.env.GMAIL_USER = 'fake-sender@example.test'; process.env.GMAIL_APP_PASSWORD = 'fake-app-password'; }
    H.db.tables.properties.push(clone(baseProperty()));
    if (setup) setup();
    const job = canaryJob();
    if (jobEdit) jobEdit(job);
    let result = null; let thrown = null;
    try { result = await a.handleWorkOrderJob(job, 'webhook'); } catch (err) { thrown = err; }
    return { result, thrown };
  }

  const bodyHasCanary = [];
  for (const [name, fn] of Object.entries(stages)) {
    let out;
    try { out = await fn(); } finally { summaryMod._setScreenForTesting(null); }
    assert.strictEqual(out.thrown, null, `${name}: handleWorkOrderJob must never throw`);
    assert.ok(out.result, `${name}: a result came back`);
    const everything = [
      JSON.stringify(out.result), JSON.stringify(H.db.writes), JSON.stringify(H.db.tables), H.logs.join('\n'),
      JSON.stringify(H.nm.sent), H.mail.sent.map((m) => m.subject).join('\n'), String(out.result.error || ''),
    ].join('\n');
    assert.ok(!everything.includes(CANARY), `${name}: the canary leaked outside the email body`);
    assert.strictEqual(H.tripwire.calls, 0, `${name}: an outbound call was attempted`);
    assert.strictEqual(H.ai.constructed, 0);
    if (H.mail.sent[0] && H.mail.sent[0].text.includes(CANARY)) bodyHasCanary.push(name);
  }
  // The stages that fail AFTER a clean block was built may legitimately show it in the body; none of the others may.
  for (const name of bodyHasCanary) assert.ok(['categorize', 'fetchJob', 'audit_writer_throws', 'audit_writer_error_message', 'sendMail_throws', 'sendMail_returns_error_echoing_body'].includes(name), `${name}: canary in a body it should not be in`);
});

test('G7 console output is constant text: scanner errors, summary errors and lookup errors never echo the text', async () => {
  const noisy = [
    { before: () => summaryMod._setScreenForTesting(() => { throw new Error(`screen said ${CANARY}`); }) },
    { before: () => { H.latchelState.getJobImpl = async () => { throw new Error(`api said ${CANARY}`); }; }, drop: true },
    { job: canaryJob({ description: `${CANARY} paint it white` }) },
    { job: canaryJob({ name: 42 }) },
  ];
  for (const n of noisy) {
    try {
      const job = n.job || canaryJob();
      if (n.drop) delete job.description;
      await send({ job, before: n.before });
      assert.ok(!H.logs.join('\n').includes(CANARY), `logs: ${H.logs.join(' | ')}`);
    } finally { summaryMod._setScreenForTesting(null); }
  }
});

test('G8 MUTANT KILLERS: the summary_error path and the outer catch never print the error message or the text', async () => {
  // Mutants M03 / M30 (job text or err.message reaching a log line). The proxy
  // below makes the summary function fail with the canary in the message.
  const job = new Proxy(canaryJob(), { getOwnPropertyDescriptor(t, p) { if (p === 'description') throw new Error(`boom ${CANARY}`); return Reflect.getOwnPropertyDescriptor(t, p); } });
  await sendRaw({ job });
  assert.ok(!H.logs.join('\n').includes(CANARY), 'summary_error path logs a constant line');
  assert.ok(H.logs.some((l) => l.includes('failing closed (held)')), 'and it does log that line');
  // The outer catch of handleWorkOrderJob: an error thrown by the mailer itself.
  const res = await sendRaw({ job: canaryJob(), before: () => { H.mail.throwNext = () => new Error(`mailer ${CANARY}`); } });
  assert.ok(!H.logs.join('\n').includes(CANARY), 'outer catch logs no message');
  assert.strictEqual(res.result.action, 'error');
  assert.strictEqual(res.result.error, 'unexpected_error');
  // With the block off, the original behaviour is kept exactly.
  const off = await sendRaw({ mode: null, job: canaryJob(), before: () => { H.mail.throwNext = () => new Error('mailer down'); } });
  assert.strictEqual(off.result.error, 'mailer down');
});

// ════════════════════════════════════════════════════════════════════════
// H. THE ALERT NEVER DEPENDS ON THE NEW BLOCK
// ════════════════════════════════════════════════════════════════════════
test('H1 the summary function throwing entirely: alert is still sent, exactly as before, with a constant log line, and the failure is audited', async () => {
  const fake = {
    prepareWorkOrderSummary: async () => { throw new Error(`broken ${CANARY}`); },
    descriptionMode: () => 'on', descriptionModeInfo: () => ({ mode: 'on', downgraded: false }), SCREEN_VERSION: 'x', descriptionScreenOn: () => true, UNSCREENED_VERSION: 'u',
  };
  const freshA = freshAlert({ stubs: { [path.resolve(H.APPROVAL_DIR, 'lib/work-order-summary.js')]: fake } });
  H.reset();
  H.db.tables.properties.push(clone(baseProperty()));
  const res = await freshA.handleWorkOrderJob(clone(baseJob()), 'webhook');
  assert.strictEqual(res.action, 'sent');
  assertIdenticalToGolden(H.mail.sent[0], 'normal-solimar');
  assert.ok(H.logs.some((l) => l.includes('could not prepare the description block')));
  assert.ok(!H.logs.join('\n').includes(CANARY));
  const ev = auditEvents(DESC_ACTION)[0];
  assert.ok(ev && ev.details.cause === 'summary_error' && ev.risk_level === 'medium');
});

test('H2 the description audit write failing (throws): alert is still sent without the block', async () => {
  const r = await send({ job: baseJob({ name: 'Faucet', description: 'drips' }), before: () => { H.db.throwOnInsert = (table, payload) => table === 'audit_log' && payload.action === DESC_ACTION; } });
  assert.strictEqual(r.result.action, 'sent');
  assertIdenticalToGolden(r.email, 'normal-solimar');
});

test('H3 a Latchel lookup that hangs does not stop the alert', async () => {
  const r = await send({ job: noDescKey(), before: () => { H.latchelState.getJobImpl = () => Promise.resolve(null); } });
  assert.strictEqual(r.result.action, 'sent');
  assert.deepStrictEqual(blockLines(r.email.text), [UNAVAILABLE_LINE]);
});

// ════════════════════════════════════════════════════════════════════════
// I. EXISTING BEHAVIOR (must all still pass)
// ════════════════════════════════════════════════════════════════════════
test('I1 a row with send_status "sent" means no second email (the existing alerts are never re-sent)', async () => {
  for (const mode of [null, 'on']) {
    const r = await send({ mode, before: () => { H.db.tables.work_order_note_alerts.push({ latchel_job_id: '5001', send_status: 'sent' }); } });
    assert.strictEqual(r.count, 0); assert.strictEqual(r.result.action, 'already_sent');
  }
  await send({ mode: 'on' });
  const again = await alert.handleWorkOrderJob(clone(baseJob()), 'reconciliation_poll');
  assert.strictEqual(again.action, 'already_sent'); assert.strictEqual(H.mail.sent.length, 1);
});

test('I2 a "failed" row is retried and flips to "sent"', async () => {
  const r = await send({ before: () => { H.db.tables.work_order_note_alerts.push({ latchel_job_id: '5001', send_status: 'failed' }); } });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(H.db.tables.work_order_note_alerts[0].send_status, 'sent');
  assert.ok(H.db.writes.some((w) => w.table === 'work_order_note_alerts' && w.op === 'update' && w.payload.send_status === 'sent'));
});

test('I3 unassigned pod: two recipients and exactly one open task; an existing open task is not duplicated', async () => {
  const s = unassignedScenario;
  let r = await send({ mode: null, job: s.job, property: s.property });
  assert.strictEqual(r.email.to.length, 2);
  assert.strictEqual(H.db.writes.filter((w) => w.table === 'tasks' && w.op === 'insert').length, 1);
  r = await send({ mode: null, job: s.job, property: s.property, before: () => { H.db.tables.tasks.push({ id: 't1', entity_type: 'property', entity_id: 'prop-0003', title: 'Property missing pod assignment', status: 'open' }); } });
  assert.strictEqual(H.db.writes.filter((w) => w.table === 'tasks' && w.op === 'insert').length, 0);
});

test('I4 no notes, unresolved property, and no job id are discarded or skipped with no send', async () => {
  let r = await send({ property: baseProperty({ maintenance_notes: '  ' }) });
  assert.strictEqual(r.count, 0); assert.strictEqual(r.result.reason, 'no_maintenance_notes');
  r = await send({ property: baseProperty({ maintenance_notes: null }) });
  assert.strictEqual(r.count, 0);
  r = await send({ job: baseJob({ property_id: 123456 }) });
  assert.strictEqual(r.count, 0); assert.strictEqual(r.result.reason, 'property_not_resolved');
  r = await send({ job: (() => { const j = baseJob(); delete j.job_id; return j; })() });
  assert.strictEqual(r.count, 0); assert.strictEqual(r.result.reason, 'no_job_id');
});

test('I5 send failure writes a "failed" row and does not touch the independent nodemailer channel when its credentials are unset', async () => {
  const r = await send({ before: () => { H.mail.nextResult = { ok: false, sent: 0, failed: 1, accepted: [], rejected: [], error: 'mailer_not_configured' }; } });
  assert.strictEqual(r.result.action, 'failed');
  const row = H.db.writes.find((w) => w.table === 'work_order_note_alerts');
  assert.strictEqual(row.payload.send_status, 'failed'); assert.strictEqual(row.payload.send_error, 'mailer_not_configured');
  assert.strictEqual(H.nm.created, 0, 'no nodemailer transport was created');
  assert.ok(H.logs.some((l) => l.includes('Could not send failure notification')));
});

test('I6 row fields are as before: notes_snapshot is the notes only, flagged columns FALSE/NULL, recipients unchanged', async () => {
  for (const mode of [null, 'shadow', 'on']) {
    await send({ mode, job: canaryJob() });
    const row = H.db.writes.find((w) => w.table === 'work_order_note_alerts' && w.op === 'insert').payload;
    assert.strictEqual(row.notes_snapshot, baseProperty().maintenance_notes);
    assert.strictEqual(row.flagged_protected_class, false); assert.strictEqual(row.flagged_category, null);
    assert.deepStrictEqual(row.recipients, ['solimar-pod@example.test']); assert.strictEqual(row.pod, 'Solimar');
    assert.strictEqual(row.send_status, 'sent');
    assert.deepStrictEqual(Object.keys(row).sort(), ['attempted_at', 'flagged_category', 'flagged_protected_class', 'latchel_job_id', 'latchel_property_id', 'notes_snapshot', 'pod', 'property_id', 'recipients', 'send_error', 'send_status', 'sent_at', 'trigger_source']);
  }
});

test('I7 reconcile-poll jobs (list shape) go through the same path', async () => {
  H.reset();
  process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on';
  process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
  H.db.tables.properties.push(clone(baseProperty()));
  const res = await alert.handleWorkOrderJob(clone(baseJob({ name: 'Faucet drip', description: 'drips' })), 'reconciliation_poll');
  assert.strictEqual(res.action, 'sent');
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.trigger_source, 'reconciliation_poll');
});

test('I8 while the description is really in the email (mode on) a send error is reduced to a short known code; with the block off or in shadow (no job text in the email) it is unchanged', async () => {
  const echo = (body) => ({ ok: false, sent: 0, failed: 1, accepted: [], rejected: [], error: `Gmail said: ${body.slice(0, 40)}` });
  for (const [mode, expected] of [[null, null], ['shadow', null], ['on', 'send_failed']]) {
    await send({ mode, job: canaryJob(), before: () => { H.mail.nextResult = echo; } });
    const row = H.db.writes.find((w) => w.table === 'work_order_note_alerts').payload;
    if (expected) assert.strictEqual(row.send_error, expected, `mode ${mode}`); else assert.ok(row.send_error.startsWith('Gmail said'), `${mode || 'off'}: the original error text is kept (no job text is in the email)`);
  }
  await send({ mode: 'on', before: () => { H.mail.nextResult = { ok: false, sent: 0, failed: 0, accepted: [], rejected: [], error: 'no_recipient' }; } });
  assert.strictEqual(H.db.writes.find((w) => w.table === 'work_order_note_alerts').payload.send_error, 'no_recipient', 'a known code is kept');
});

// ════════════════════════════════════════════════════════════════════════
// J. SCOPE: the field allowlist, forbidden fields, dormant modules, documents
// ════════════════════════════════════════════════════════════════════════
const ALLOWED_JOB_KEYS = new Set(['name', 'description', 'is_emergency', 'is_urgent']);
// The lookup result's own id is read once, to confirm it is the job that was asked for (never displayed).
const ALLOWED_LOOKUP_KEYS = new Set([...ALLOWED_JOB_KEYS, 'job_id', 'id']);

function recordingProxy(target, log, allowed = ALLOWED_JOB_KEYS) {
  const check = (prop, how) => {
    if (typeof prop === 'symbol' || prop === 'then') return; // 'then' is read by the Promise machinery, not by the feature
    log.push(`${how}:${prop}`);
    if (!allowed.has(prop)) throw new Error(`FORBIDDEN READ of "${prop}" (${how})`);
  };
  return new Proxy(target, {
    get(t, prop, rcv) { check(prop, 'get'); return Reflect.get(t, prop, rcv); },
    has(t, prop) { check(prop, 'has'); return Reflect.has(t, prop); },
    getOwnPropertyDescriptor(t, prop) { check(prop, 'descriptor'); return Reflect.getOwnPropertyDescriptor(t, prop); },
    ownKeys() { throw new Error('FORBIDDEN: enumerating the keys of a job'); },
  });
}

const FULL_DETAIL = () => ({
  job_id: 5001, name: 'Detail title', description: 'Detail says the sink is clogged.', is_emergency: false, is_urgent: true,
  access_instructions: `${CANARY} gate code 1234`, vendor_description: `${CANARY} vendor`, estimate_note: `${CANARY} estimate`,
  estimate: 1200, max_cost: 500, rating_comments: `${CANARY} rating`, job_rating: 5, tenant_id: 77, location_id: 8, vendor_id: 9, vendor_rating: 4,
});

test('J1 FIELD ALLOWLIST: only name, description, is_emergency and is_urgent are ever read, from the job and from the lookup result (plus the lookup result\'s job id, once, to confirm it is the right job)', async () => {
  // job in hand carries a description
  let reads = [];
  let s = await prepareWorkOrderSummary(recordingProxy(FULL_DETAIL(), reads), { jobId: '5001' });
  assert.strictEqual(s.status, 'shown');
  assert.ok(reads.length > 0 && reads.every((r) => ALLOWED_JOB_KEYS.has(r.split(':')[1])), reads.join(','));
  assert.ok(!s.lines.join('\n').includes(CANARY));
  // job without a description key: the lookup result is read the same way
  reads = [];
  const lean = { job_id: 5001, name: 'x' };
  s = await prepareWorkOrderSummary(lean, { jobId: '5001', fetchJob: async () => recordingProxy(FULL_DETAIL(), reads, ALLOWED_LOOKUP_KEYS) });
  assert.strictEqual(s.status, 'shown'); assert.strictEqual(s.meta.fallback_getjob_used, true);
  assert.ok(reads.length > 0 && reads.every((r) => ALLOWED_LOOKUP_KEYS.has(r.split(':')[1])), reads.join(','));
  assert.ok(reads.some((r) => r.endsWith(':job_id')), 'the id check reads job_id');
  assert.ok(s.lines.some((l) => l.includes('Priority: Urgent')));
  assert.ok(!s.lines.join('\n').includes(CANARY));
  // held and unassigned: still nothing else
  reads = [];
  s = await prepareWorkOrderSummary(recordingProxy({ ...FULL_DETAIL(), description: 'tenant uses a wheelchair' }, reads), {});
  assert.strictEqual(s.status, 'held');
  assert.ok(reads.every((r) => ALLOWED_JOB_KEYS.has(r.split(':')[1])));
  // a read of any other key would have thrown inside the proxy; prove the proxy itself bites
  assert.throws(() => recordingProxy({ access_instructions: 'x' }, []).access_instructions, /FORBIDDEN READ/);
});

test('J2 source check: the feature never reads a forbidden Latchel field or the synced AppFolio table', async () => {
  const files = ['lib/work-order-summary.js', 'lib/work-order-text-clean.js', 'lib/work-order-text-screen.js', 'lib/work-order-text-screen-terms.js', 'lib/work-order-notes-alert.js'];
  const forbidden = /\.(access_instructions|vendor_description|estimate_note|estimate|max_cost|rating_comments|job_rating|tenant_id|location_id|vendor_id|vendor_rating)\b|\[['"](access_instructions|vendor_description|estimate_note|max_cost|rating_comments|tenant_id|location_id)['"]\]/;
  for (const f of files) {
    const src = fs.readFileSync(path.resolve(H.APPROVAL_DIR, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!forbidden.test(code), `${f} reads a forbidden field`);
    assert.ok(!/maintenance_requests/.test(code), `${f} must not read maintenance_requests`);
  }
  const summarySrc = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-summary.js'), 'utf8');
  assert.ok(/source\.name/.test(summarySrc) && /source\.description/.test(summarySrc), 'reads job.name and job.description');
  const reads = [...summarySrc.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\bsource\.([A-Za-z_]+)/g)].map((m) => m[1]);
  for (const k of reads) assert.ok(ALLOWED_JOB_KEYS.has(k), `summary reads source.${k}`);
});

test('J3 the dormant notes content-check modules and the retired AI check are not wired in or present', async () => {
  for (const f of ['lib/work-order-notes-alert.js', 'lib/work-order-summary.js', 'lib/work-order-text-clean.js', 'lib/work-order-text-screen.js', 'lib/work-order-text-screen-terms.js']) {
    const code = fs.readFileSync(path.resolve(H.APPROVAL_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/work-order-notes-(content-check|classifier)/.test(code), `${f} must not require the dormant notes check`);
    assert.ok(!/work-order-description-check/.test(code), `${f} must not require the retired AI check`);
  }
  assert.ok(!fs.existsSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-description-check.js')), 'the AI check module is deleted');
  // No leftover of the retired AI check anywhere in the feature's own files.
  // (Built from pieces so this file does not contain the words it forbids.)
  const retired = K.RETIRED_AI_WORDS;
  const root = path.resolve(H.HUB_DIR, '../..');
  const mine = [
    ...['lib/work-order-notes-alert.js', 'lib/work-order-summary.js', 'lib/work-order-text-clean.js', 'lib/work-order-text-screen.js', 'lib/work-order-text-screen-terms.js'].map((f) => path.resolve(H.APPROVAL_DIR, f)),
    ...fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') || f.endsWith('.json')).map((f) => path.join(__dirname, f)),
    path.join(root, '.env.example'), path.resolve(H.HUB_DIR, 'work-order-notes-alert-SPEC.md'),
    ...fs.readdirSync(path.join(root, 'compliance')).filter((f) => f.startsWith('work-order-note-alerts-description')).map((f) => path.join(root, 'compliance', f)),
  ];
  for (const f of mine) {
    const src = fs.readFileSync(f, 'utf8');
    for (const word of retired) assert.ok(!src.includes(word), `${path.relative(root, f)} still mentions a retired AI identifier`);
  }
});

test('J4 every compliance document the feature code points at exists', async () => {
  const root = path.resolve(H.HUB_DIR, '../..');
  for (const f of ['lib/work-order-notes-alert.js', 'lib/work-order-summary.js', 'lib/work-order-text-clean.js', 'lib/work-order-text-screen.js', 'lib/work-order-text-screen-terms.js', 'router.js']) {
    const src = fs.readFileSync(path.resolve(H.APPROVAL_DIR, f), 'utf8');
    for (const m of src.matchAll(/compliance\/([a-z0-9-]+\.md)/g)) {
      assert.ok(fs.existsSync(path.join(root, 'compliance', m[1])), `${f} points at compliance/${m[1]}, which does not exist`);
    }
  }
  for (const doc of ['work-order-note-alerts-description-governance-review.md', 'work-order-note-alerts-description-decision-resolution.md']) {
    assert.ok(fs.existsSync(path.join(root, 'compliance', doc)), `${doc} must exist`);
  }
});

test('J5 nothing in this suite made a real network call or built a model client', async () => {
  assert.strictEqual(H.tripwire.calls, 0);
  assert.strictEqual(H.ai.constructed, 0);
});

// ════════════════════════════════════════════════════════════════════════
// K. ROBUSTNESS: same-job concurrency, in-flight expiry, hostile input size
// ════════════════════════════════════════════════════════════════════════
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('K1 two deliveries of the SAME job at once (created + updated) send one email; different jobs are independent', async () => {
  for (const mode of ['shadow', 'on']) {
    H.reset();
    process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = mode;
    process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
    H.db.tables.properties.push(clone(baseProperty()));
    H.mail.nextResult = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, sent: 1, failed: 0, accepted: ['x'], rejected: [], error: null }), 60));
    const job = baseJob({ name: 'Faucet', description: 'drips' });
    const [a, b] = await Promise.all([alert.handleWorkOrderJob(clone(job), 'webhook'), alert.handleWorkOrderJob(clone(job), 'webhook')]);
    assert.strictEqual(H.mail.sent.length, 1, `${mode}: exactly one email for one job`);
    assert.deepStrictEqual([a.action, b.action].sort(), ['already_sent', 'sent']);
    H.mail.nextResult = null;
    const later = await alert.handleWorkOrderJob(clone(job), 'reconciliation_poll');
    assert.strictEqual(later.action, 'already_sent'); assert.strictEqual(H.mail.sent.length, 1);
  }
  H.reset();
  process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on';
  process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
  H.db.tables.properties.push(clone(baseProperty()));
  await Promise.all([
    alert.handleWorkOrderJob(clone(baseJob({ job_id: 5101, name: 'A', description: 'a' })), 'webhook'),
    alert.handleWorkOrderJob(clone(baseJob({ job_id: 5102, name: 'B', description: 'b' })), 'webhook'),
  ]);
  assert.strictEqual(H.mail.sent.length, 2, 'different jobs both send');
});

test('K2 a failed attempt does not wedge the guard: the next delivery retries and sends', async () => {
  H.reset();
  process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on';
  process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
  H.db.tables.properties.push(clone(baseProperty()));
  H.mail.nextResult = { ok: false, sent: 0, failed: 1, accepted: [], rejected: [], error: 'mailer_not_configured' };
  const first = await alert.handleWorkOrderJob(clone(baseJob()), 'webhook');
  assert.strictEqual(first.action, 'failed');
  H.mail.nextResult = null;
  const second = await alert.handleWorkOrderJob(clone(baseJob()), 'reconciliation_poll');
  assert.strictEqual(second.action, 'sent');
});

/** Runs fn with a controllable fake clock, always restoring the real one. */
async function withClock(fn) {
  let now = 1_000_000;
  alert._setClockForTesting(() => now);
  try { return await fn({ at: () => now, advance: (ms) => { now += ms; } }); } finally { alert._setClockForTesting(); }
}

function hangingSend() {
  let release;
  const gate = new Promise((resolve) => { release = () => resolve({ ok: true, sent: 1, failed: 0, accepted: ['x'], rejected: [], error: null }); });
  return { gate, release };
}

test('K3 IN-FLIGHT EXPIRY (fake clock): a fresh entry blocks, a stale one does not, and a hung send never blocks later deliveries after 5 minutes', async () => {
  await withClock(async (clock) => {
    H.reset();
    process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'shadow';
    H.db.tables.properties.push(clone(baseProperty()));
    const hung = hangingSend();
    H.mail.nextResult = () => hung.gate;
    const a = alert.handleWorkOrderJob(clone(baseJob()), 'webhook'); // hangs in sendMail
    await tick(); await tick();
    assert.strictEqual(alert._inFlightSizeForTesting(), 1);
    clock.advance(4 * 60 * 1000 + 59 * 1000);
    const blocked = await alert.handleWorkOrderJob(clone(baseJob()), 'reconciliation_poll');
    assert.deepStrictEqual(blocked, { action: 'already_sent', in_flight: true }, 'fresh entry (4:59) blocks');
    clock.advance(1000); // exactly 5:00 is still fresh
    assert.strictEqual((await alert.handleWorkOrderJob(clone(baseJob()), 'reconciliation_poll')).in_flight, true);
    clock.advance(1001); // 5:00.001 is stale
    H.mail.nextResult = null;
    H.logs.length = 0;
    const c = await alert.handleWorkOrderJob(clone(baseJob()), 'reconciliation_poll');
    assert.strictEqual(c.action, 'sent', 'a stale entry is ignored: the delivery goes through');
    assert.strictEqual(H.logs.filter((l) => l.includes('old in-flight entry was ignored')).length, 1, 'one constant log line');
    assert.strictEqual(alert._inFlightSizeForTesting(), 0, 'the newer run removed its own entry');
    hung.release(); await a;
  });
});

test('K4 IN-FLIGHT TOKEN: a stale run that finally finishes cannot delete a newer run\'s entry', async () => {
  await withClock(async (clock) => {
    H.reset();
    process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'shadow';
    H.db.tables.properties.push(clone(baseProperty()));
    const first = hangingSend(); const second = hangingSend();
    H.mail.nextResult = () => first.gate;
    const a = alert.handleWorkOrderJob(clone(baseJob()), 'webhook');
    await tick(); await tick();
    clock.advance(6 * 60 * 1000);
    H.mail.nextResult = () => second.gate;
    const c = alert.handleWorkOrderJob(clone(baseJob()), 'reconciliation_poll');
    await tick(); await tick();
    assert.strictEqual(alert._inFlightSizeForTesting(), 1, 'the newer run owns the entry');
    first.release(); await a; // the stale run ends first
    assert.strictEqual(alert._inFlightSizeForTesting(), 1, 'the stale run did not delete the newer entry');
    const d = await alert.handleWorkOrderJob(clone(baseJob()), 'reconciliation_poll');
    assert.strictEqual(d.in_flight, true, 'so the newer run is still protected');
    second.release(); await c;
    assert.strictEqual(alert._inFlightSizeForTesting(), 0);
  });
});

test('K5 IN-FLIGHT PRUNING: expired entries for other jobs are dropped on every guarded call, so the map stays bounded', async () => {
  await withClock(async (clock) => {
    H.reset();
    process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'shadow';
    H.db.tables.properties.push(clone(baseProperty()));
    const gates = [];
    const pending = [];
    for (let i = 0; i < 25; i++) {
      const g = hangingSend(); gates.push(g);
      H.mail.nextResult = () => g.gate;
      pending.push(alert.handleWorkOrderJob(clone(baseJob({ job_id: 7000 + i, order_number: 9000 + i })), 'webhook'));
      await tick(); await tick();
    }
    assert.strictEqual(alert._inFlightSizeForTesting(), 25);
    clock.advance(10 * 60 * 1000);
    H.mail.nextResult = null;
    await alert.handleWorkOrderJob(clone(baseJob({ job_id: 7999 })), 'webhook');
    assert.ok(alert._inFlightSizeForTesting() <= 1, `bounded after pruning, size ${alert._inFlightSizeForTesting()}`);
    for (const g of gates) g.release();
    await Promise.all(pending);
    assert.strictEqual(alert._inFlightSizeForTesting(), 0);
  });
});

test('K6 mode off is unchanged: no guard entry is ever made', async () => {
  H.reset();
  H.db.tables.properties.push(clone(baseProperty()));
  const hung = hangingSend();
  H.mail.nextResult = () => hung.gate;
  const a = alert.handleWorkOrderJob(clone(baseJob()), 'webhook');
  await tick(); await tick();
  assert.strictEqual(alert._inFlightSizeForTesting(), 0, 'mode off: nothing in the map');
  hung.release(); await a;
});

test('K7 a hostile or huge description is bounded: no hang, no throw, nothing past the cap', async () => {
  const { spawnSync } = require('child_process');
  const modPath = path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-clean.js');
  const t0 = Date.now();
  const child = spawnSync(process.execPath, ['-e', `
    const { cleanText } = require(${JSON.stringify(modPath)});
    const run = (s) => { try { return cleanText(s); } catch (e) { return 'ERR:' + e.message; } };
    const a = run('<a'.repeat(500000));
    const b = run('<br'.repeat(500000));
    const c = run('x '.repeat(500000));
    const d = run('<script'.repeat(500000));
    const e = run('www.'.repeat(500000));
    if (c.length > 20000) { console.log('NOT_CAPPED'); process.exit(2); }
    console.log('OK');
  `], { timeout: 15000, env: { PATH: process.env.PATH, HOME: '/tmp/x' }, encoding: 'utf8' });
  assert.strictEqual(child.status, 0, `child ended with status ${child.status} signal ${child.signal} after ${Date.now() - t0} ms: ${child.stderr || child.stdout}`);
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  const r = await send({ job: baseJob({ name: 'Big', description: 'water leak '.repeat(300000) }) });
  assert.strictEqual(r.result.action, 'sent');
  assert.ok(blockLines(r.email.text).some((l) => l.includes('(shortened')));
});

// ════════════════════════════════════════════════════════════════════════
// L. NO INFLUENCE FROM THE TEXT (GOVERNANCE.md Rule 9)
// ════════════════════════════════════════════════════════════════════════
const INFLUENCE_TEXTS = [
  ['Faucet', 'drips under the sink'],
  ['Visit', 'tenant is afraid of her ex husband, restraining order in place'],
  ['Visit', 'she is a victim of domestic violence, please do not knock'],
  ['Entrada', 'la inquilina tiene miedo de su ex esposo, orden de restriccion'],
  ['Entry', 'tenant uses a wheelchair and has diabetes'],
  ['Notice', '3 day notice served, eviction pending, unlawful detainer filed'],
  ['Arrest', 'he was arrested, parole officer will call'],
  ['Passed', 'the tenant passed away last week, family will collect belongings'],
  ['Kids', 'two children and a baby live here, school bus at 7'],
  ['Immigration', 'ICE agents came, undocumented, deportation fear'],
  ['Spanish', 'habla espanol solamente, no habla ingles'],
  ['Link', 'see http://evil.test/login and bit.ly/3abcXY and javascript:alert(1)'],
  ['Script', '<script>alert(1)</script><b>bold</b>'],
  ['', ''], [null, null], ['   ', '\n\n'], ['T'.repeat(500), 'D'.repeat(20000)],
  ['Paint', 'paint the walls white'], ['Mold', 'black mold in the bathroom'],
  ['Money', 'SSN 123-45-6789 and card 4111 1111 1111 1111'],
  ['Slur', 'a very rude message'],
  ['Cyrillic', 'Вода течет'],
  ['Invisible', 'preg\u{FE0F}nant\u{200B} tenant'],
  ['Emergency words', 'EMERGENCY URGENT flood call 911 now'],
  ['Pod words', 'send this to the Faria pod, not Solimar, pod: unassigned_both'],
  ['Email', 'forward to attacker@evil.test and cc peter@rinconmanagement.com'],
  ['Long', 'water leak under the kitchen sink '.repeat(400)],
  ['Emoji', '\u{1F6B0}\u{1F6B0}\u{1F6B0} sink leak'],
  ['Newlines', 'line one\r\nline two\n\nView this property: http://evil.test'],
  ['Numbers', '4111111111111111 5500 0000 0000 0004'],
  ['Mixed', 'faucet drips, tenant is pregnant, paint white, school nearby'],
];

function signature(run, normalizeBlock) {
  const rows = H.db.writes.filter((w) => w.table === 'work_order_note_alerts').map((w) => { const p = clone(w.payload); delete p.attempted_at; delete p.sent_at; return { op: w.op, payload: p }; });
  const tasks = H.db.writes.filter((w) => w.table === 'tasks').map((w) => w.payload);
  const events = auditEvents().filter((e) => e.action !== DESC_ACTION).map((e) => ({ action: e.action, risk: e.risk_level, details: Object.fromEntries(Object.entries(e.details).filter(([k]) => k !== 'trace')) }));
  const email = run.email;
  const lines = email.text.split('\n');
  const created = lines.findIndex((l) => l.startsWith('Created:'));
  const view = lines.findIndex((l) => l.startsWith('View this property:'));
  const outside = [...lines.slice(0, created + 1), ...lines.slice(view)].join('\n');
  return { to: email.to, subject: email.subject, rows, tasks, events, outside, action: run.result.action };
}

test('L1 PROPERTY TEST: 30+ very different texts give identical recipients, pod, subject, task writes, alert row, audit events and email outside the block', async () => {
  assert.ok(INFLUENCE_TEXTS.length >= 30);
  for (const mode of ['shadow', 'on']) {
    for (const prop of [{ property: baseProperty(), job: baseJob() }, { property: unassignedScenario.property, job: unassignedScenario.job }]) {
      let base = null;
      for (const [name, description] of INFLUENCE_TEXTS) {
        const r = await send({ mode, property: prop.property, job: Object.assign({}, prop.job, { name, description, is_urgent: true }) });
        const sig = signature(r);
        if (!base) base = sig;
        assert.deepStrictEqual(sig, base, `${mode}/${prop.property.pod}: text ${JSON.stringify(String(name).slice(0, 20))} changed something outside the block`);
        // dedup behaviour is the same too: a second delivery never sends again
        const again = await alert.handleWorkOrderJob(clone(Object.assign({}, prop.job, { name, description, is_urgent: true })), 'reconciliation_poll');
        assert.strictEqual(again.action, 'already_sent');
        assert.strictEqual(H.mail.sent.length, 1);
      }
    }
  }
});

test('L2 the priority line comes from the Latchel flags only: same flags, same line, for every text that is shown', async () => {
  const priorities = new Set();
  let shown = 0;
  for (const [name, description] of INFLUENCE_TEXTS) {
    const r = await send({ job: Object.assign(baseJob(), { name, description, is_urgent: true, is_emergency: false }) });
    const b = blockLines(r.email.text);
    const p = b.filter((l) => l.startsWith('  Priority:'));
    if (b.length > 2 || b[0] !== HEADER) { /* shown */ }
    if (p.length) { shown++; priorities.add(p[0]); }
  }
  assert.ok(shown >= 5);
  assert.deepStrictEqual([...priorities], ['  Priority: Urgent (flagged in Latchel)']);
});

test('L3 SOURCE-LEVEL: recipients, the dedup lookup, the subject and the task write receive nothing derived from the text or the summary', async () => {
  const src = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-notes-alert.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const derived = /description|summary|screen|clean|block|lines|verdict|held|categor|title|\.name\b/i;
  for (const fn of ['resolveRecipients', 'getExistingAlertRow', 'flagMissingPod', 'resolvePropertyByLatchelId']) {
    const calls = [...code.matchAll(new RegExp(`(?<![A-Za-z])${fn}\\(([^)]*)\\)`, 'g'))].filter((m) => !/^\s*(async\s+)?function/.test(code.slice(Math.max(0, m.index - 20), m.index)));
    assert.ok(calls.length >= 1, `${fn} is called`);
    for (const m of calls) {
      const before = code.slice(Math.max(0, m.index - 16), m.index);
      if (/function\s*$/.test(before)) continue; // the definition itself
      assert.ok(!derived.test(m[1]), `${fn}(${m[1]}) receives something derived from the text`);
    }
  }
  const subjectLine = code.split('\n').find((l) => /const subject = /.test(l));
  assert.ok(subjectLine, 'subject builder found');
  assert.deepStrictEqual([...subjectLine.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]), ['propertyLabel'], 'the subject uses only the property label');
  // the block is prepared AFTER the recipients are resolved, and its result is used only as display lines
  assert.ok(code.indexOf('await resolveRecipients(') < code.indexOf('await prepareDescriptionBlock('), 'recipients first, block second');
  assert.ok([...code.matchAll(/descriptionLines/g)].length >= 4, 'descriptionLines is used');
  assert.ok(!/(recipients|pod)\s*(\.push|=)[^;\n]*descriptionLines/.test(code), 'lines never feed recipients or pod');
  // and the Rule 9 sentence is in the code and the spec
  assert.ok(/RULE 9/.test(src));
  const spec = fs.readFileSync(path.resolve(H.HUB_DIR, 'work-order-notes-alert-SPEC.md'), 'utf8');
  assert.ok(/Rule 9/.test(spec) && /only decide what is displayed/i.test(spec), 'the spec states Rule 9 for this block');
});

// ════════════════════════════════════════════════════════════════════════
runner.run();
