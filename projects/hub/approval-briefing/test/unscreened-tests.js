#!/usr/bin/env node
/**
 * test/unscreened-tests.js
 *
 * Tests for the owner's switch that turns the content screen off
 * (WORK_ORDER_ALERT_DESCRIPTION_SCREEN=off, added 2026-10-17 on Peter's explicit
 * instruction; an owner override recorded as such, never a met condition). One
 * group per requirement:
 *
 *   U1   the switch: only the lowercase value "off" turns the screen off
 *   U2   it is independent of the mode and the interlock (mode off / shadow / on-without-interlock)
 *   U3   with the switch unset (or anything but "off") the code reproduces commit c781a1b byte for byte
 *   U4   screen off: sensitive synthetic text is shown word for word, the screen is never consulted
 *   U5   the cleaner's hygiene stays: links, markup, invisible characters, line breaks, header injection, quote forging, the cut
 *        and a hold the cleaner would ask for becomes a replacement
 *   U6   the never-store mask replaces SSNs, card numbers, bank numbers and passwords (both directions)
 *   U7   the mask's false-positive corpus: ordinary numbers and words are left alone
 *   U8   the mask's known limits are pinned (what it does NOT catch)
 *   U9   the mask agrees with the screen's own SSN and card test where they overlap
 *   U10  the last line of the block says the text is not screened
 *   U11  an unassigned pod gets the text too (nothing is held), and screen on is unchanged
 *   U12  the audit row: the same eleven keys plus trace, the constant version, no text, no category
 *   U13  no AI, no network
 *   U14  fail-soft: a failure never stops the alert, and never leaks text
 *   U15  only the four allowed keys of the job are read
 *   U16  invariants over thousands of generated hostile strings
 *   U17  for ordinary text the screen-off block is the screen-on block except for its last line
 *   U18  the block length with the screen off
 *   U19  the documents say what the code does
 *
 * SAFETY: no real email, no real database, no real Latchel, no model, no .env
 * read. All text is invented.
 *
 * Run alone:  node projects/hub/approval-briefing/test/unscreened-tests.js
 */

'use strict';

const K = require('./test-kit'); // first: sets env, stubs, tripwires
const {
  H, assert, path, alert, summaryMod, SCENARIOS, baseProperty, baseJob,
  HEADER, HELD_NOTICE, UNASSIGNED_NOTICE, DESC_ACTION, CANARY,
  clone, goldenByName, send, auditEvents, blockLines, everythingExceptBody, assertIdenticalToGolden, freshAlert, rng,
} = K;
const fs = require('fs');
const cleanMod = H.load('lib/work-order-text-clean.js');
const screenMod = H.load('lib/work-order-text-screen.js');
const lib = require('./golden-on-lib');
const goldenOn = require('./golden-on-c781a1b.json');

const {
  prepareWorkOrderSummary, descriptionScreenOn, UNSCREENED_FOOTER, UNSCREENED_VERSION, SHOWN_FOOTER, NONE_LINE, UNAVAILABLE_LINE,
  NO_DESCRIPTION, CUT_POINTER, TITLE_MAX, DESCRIPTION_MAX, SCREEN_VERSION,
} = summaryMod;
const { maskNeverStore, cleanTextUnscreened, MASK_TEXT, LINK_TEXT, containsLink, hasFoldedLink, INVISIBLE_TEST } = cleanMod;
const REPO = path.resolve(H.HUB_DIR, '../..');
const readDoc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const cp = (...codes) => String.fromCodePoint(...codes);

const runner = K.makeRunner('Work Order Alert - the owner switch that turns the content screen off');
const { test } = runner;

const AUDIT_KEYS = ['cause', 'common_word_only', 'fallback_getjob_used', 'latchel_job_id', 'mode', 'on_downgraded', 'pod_unassigned', 'result', 'screen_version', 'trace', 'trigger_source', 'truncated'];
const SCREEN_OFF = 'off';

/** `before` hook for K.send: the screen switch set to `value` (left unset when undefined), then any extra setup. */
const withScreen = (value, extra) => () => {
  if (value !== undefined) process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = value;
  if (extra) extra();
};
/** Sends one job with the screen switched off. */
const sendOff = (opts = {}) => send({ ...opts, before: withScreen(SCREEN_OFF, opts.before) });

const descLine = (text) => blockLines(text).find((l) => l.startsWith('  Description:'));
const titleLine = (text) => blockLines(text).find((l) => l.startsWith('  Title:'));
const quoted = (line) => line.slice('  Description: "'.length, line.lastIndexOf('"'));

// ════════════════════════════════════════════════════════════════════════
// U1. THE SWITCH
// ════════════════════════════════════════════════════════════════════════
const SENSITIVE = baseJob({ name: 'Locks', description: 'My husband hit me last night, I need the locks changed.' });

test('U1a only the lowercase value "off" turns the screen off; unset, empty, on, ON, Off, OFF, " off", "off " and anything else leave it ON (held exactly as before)', async () => {
  const notOff = [undefined, '', 'on', 'ON', 'On', 'Off', 'OFF', 'oFF', ' off', 'off ', 'off\n', '\toff', 'false', '0', 'no', 'disabled', 'offf', 'of', 'true', 'yes', 'shadow', 'x'];
  for (const v of notOff) {
    H.reset();
    if (v !== undefined) process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = v;
    assert.strictEqual(descriptionScreenOn(), true, `${JSON.stringify(v)} must leave the screen ON`);
    const r = await send({ job: SENSITIVE, before: withScreen(v) });
    assert.deepStrictEqual(blockLines(r.email.text), [HEADER, HELD_NOTICE], `${JSON.stringify(v)}: the sensitive text is held as before`);
    const ev = auditEvents(DESC_ACTION)[0];
    assert.strictEqual(ev.details.result, 'held');
    assert.strictEqual(ev.details.cause, 'local_screen');
    assert.strictEqual(ev.details.screen_version, SCREEN_VERSION);
  }
  H.reset();
  process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = 'off';
  assert.strictEqual(descriptionScreenOn(), false);
  const r = await sendOff({ job: SENSITIVE });
  assert.strictEqual(descLine(r.email.text), `  Description: "${SENSITIVE.description}"`);
  assert.strictEqual(r.result.action, 'sent');
});

test('U1b the switch is read at the moment of each alert (no caching): flipping it between two alerts changes the second', async () => {
  const a = await send({ job: SENSITIVE });
  assert.deepStrictEqual(blockLines(a.email.text), [HEADER, HELD_NOTICE]);
  const b = await sendOff({ job: SENSITIVE });
  assert.ok(descLine(b.email.text));
  const c = await send({ job: SENSITIVE });
  assert.deepStrictEqual(blockLines(c.email.text), [HEADER, HELD_NOTICE]);
});

// ════════════════════════════════════════════════════════════════════════
// U2. INDEPENDENT OF THE MODE AND THE INTERLOCK
// ════════════════════════════════════════════════════════════════════════
test('U2a mode off / unset with the screen switch "off": nothing runs, every scenario is byte-identical to the parent output, no audit row, no lookup', async () => {
  for (const mode of [null, 'off', 'bogus', 'ON', 'Shadow']) {
    for (const s of SCENARIOS) {
      const r = await send({ mode, job: s.job, property: s.property, before: withScreen(SCREEN_OFF, () => { H.latchelState.getJobImpl = async () => baseJob(); }) });
      assertIdenticalToGolden(r.email, s.name);
      assert.strictEqual(auditEvents(DESC_ACTION).length, 0, `${s.name}/${mode}: no description audit row`);
      assert.strictEqual(H.latchelState.getJobCalls.length, 0, `${s.name}/${mode}: no Latchel call`);
    }
  }
});

test('U2b shadow mode with the screen "off": email byte-identical to the parent output, one counts-only audit row recording the unscreened version, nothing in the email', async () => {
  for (const s of SCENARIOS) {
    const r = await sendOff({ mode: 'shadow', job: s.job, property: s.property, before: () => { H.latchelState.getJobImpl = async () => baseJob(); } });
    assertIdenticalToGolden(r.email, s.name);
    const ev = auditEvents(DESC_ACTION);
    assert.strictEqual(ev.length, 1, `${s.name}: exactly one description audit row`);
    assert.strictEqual(ev[0].details.screen_version, UNSCREENED_VERSION);
    assert.strictEqual(ev[0].details.mode, 'shadow');
  }
  const r = await sendOff({ mode: 'shadow', job: SENSITIVE });
  assert.ok(!r.email.text.includes('What the work order is') && !r.email.text.includes('husband'), 'shadow never puts the block in the email');
  const ev = auditEvents(DESC_ACTION)[0];
  assert.strictEqual(ev.details.result, 'shown');
  assert.strictEqual(ev.details.cause, null);
  assert.ok(!JSON.stringify(H.db.writes).includes('husband') && !H.logs.join('\n').includes('husband'));
});

test('U2c mode "on" without the ingestion interlock stays shadow even with the screen "off"; with the interlock it shows the block', async () => {
  for (const v of [undefined, 'no', 'YES', 'true', '']) {
    const r = await sendOff({ mode: 'on', interlock: false, job: SENSITIVE, before: () => { if (v !== undefined) process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = v; } });
    assert.ok(!r.email.text.includes('What the work order is'), `interlock ${JSON.stringify(v)}: no block`);
    const ev = auditEvents(DESC_ACTION)[0];
    assert.strictEqual(ev.details.mode, 'shadow');
    assert.strictEqual(ev.details.on_downgraded, true);
    assert.strictEqual(ev.details.screen_version, UNSCREENED_VERSION);
  }
  const r = await sendOff({ mode: 'on', job: SENSITIVE });
  assert.ok(r.email.text.includes(SENSITIVE.description));
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.mode, 'on');
});

// ════════════════════════════════════════════════════════════════════════
// U3. SWITCH UNSET OR NOT "off": BYTE-IDENTICAL TO c781a1b
// ════════════════════════════════════════════════════════════════════════
test('U3 with the switch unset, empty, "on", "ON", "OFF", " off", "off " or bogus, 42 cases x shadow / on / on-without-interlock reproduce the c781a1b record exactly (email, recipients, audit rows, other writes, log lines)', async () => {
  assert.ok(goldenOn.cases.length >= 40);
  const cases = lib.buildCases({ baseJob, baseProperty });
  assert.deepStrictEqual(goldenOn.cases.map((c) => c.name), cases.map((c) => c.name), 'the fixture and the case list agree');
  let compared = 0;
  for (const value of [undefined, '', 'on', 'ON', 'Off', 'OFF', ' off', 'off ', 'bogus']) {
    for (const g of goldenOn.cases) {
      const c = cases.find((x) => x.name === g.name);
      for (const [setting, setup] of Object.entries(lib.SETTINGS)) {
        const rec = await lib.record({ H, alert }, c, baseProperty, (env) => { setup(env); if (value !== undefined) env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = value; });
        assert.deepStrictEqual(rec, g.settings[setting], `${g.name} / ${setting} / switch ${JSON.stringify(value)} differs from c781a1b`);
        compared++;
      }
    }
  }
  assert.ok(compared >= 1000, `${compared} comparisons`);
  process.stdout.write(`      (${compared} case/setting/value comparisons against the c781a1b record, 0 differences)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// U4. SCREEN OFF: NOTHING IS WITHHELD
// ════════════════════════════════════════════════════════════════════════
// Synthetic. Each is held by the real screen (checked below), and is shown word for word with the screen off.
const SENSITIVE_TEXTS = [
  ['Locks', 'My husband hit me last night, I need the locks changed.'],
  ['Entry', 'I am undocumented and afraid to let the inspector in.'],
  ['Bathroom', 'I use a wheelchair and cannot reach the shower, please install a grab bar.'],
  ['Bathroom', 'I have cancer and need a grab bar in the shower.'],
  ['Notice', 'The tenant received a 3 day notice last week.'],
  ['Inspection', 'Section 8 inspection next Tuesday morning.'],
  ['Visit', 'Tenant is pregnant, please call before arriving.'],
  ['Order', 'She has a restraining order against her ex husband, do not give him the key.'],
  ['Door', 'Tenant passed away last month, family is collecting belongings.'],
  ['Window', 'Tenant takes medication for depression and asked for quiet hours.'],
  ['Move', 'The family is receiving food stamps and cannot pay the repair fee.'],
  ['Idioma', 'El nino esta enfermo y la familia no habla ingles.'],
  ['Ramp', 'Tenant is blind and needs the rail repaired.'],
  ['Church', 'Tenant asked for a day off from the repair because of a religious holiday.'],
  ['Arrest', 'He was arrested last week and the door was damaged by police.'],
  ['Walls', 'Paint the hallway walls white after the plumber patches the drywall.'],
  ['Immigration', 'Tenant is worried about ICE agents coming to the building.'],
];
// Shown with the screen on as well (the screen has no word for them); the owner decided they pass through: not masked either.
const PASS_THROUGH_TEXTS = [
  ['Gate', 'Call John Smith at 951-555-1234 or john@example.com, gate code 2040, lockbox 7788.'],
  ['Window', 'Emma, age 4, can reach the broken window latch in the back bedroom.'],
  ['Codes', 'Alarm code is 4455 and the garage code is 90210.'],
  ['Contact', 'Owner is Maria Lopez, mobile (951) 555-0199, unit 5B.'],
  ['Age', 'Tenant is 82 years old and lives alone.'],   // a protected-class fact the screen has no word for: a miss either way
];

test('U4a with the screen OFF, every sensitive synthetic text is shown word for word (title and description), nothing is held, and the screen is never asked', async () => {
  let asked = 0;
  summaryMod._setScreenForTesting(() => { asked++; throw new Error('the screen must not be consulted'); });
  try {
    for (const [name, description] of [...SENSITIVE_TEXTS, ...PASS_THROUGH_TEXTS]) {
      const r = await sendOff({ job: baseJob({ name, description }) });
      assert.strictEqual(r.result.action, 'sent');
      const b = blockLines(r.email.text);
      assert.strictEqual(b[0], HEADER);
      assert.ok(!b.includes(HELD_NOTICE) && !b.includes(UNASSIGNED_NOTICE), `held: ${description}`);
      assert.strictEqual(titleLine(r.email.text), `  Title: ${name}`);
      assert.strictEqual(descLine(r.email.text), `  Description: "${description}"`, `withheld or changed: ${description}`);
      assert.strictEqual(b[b.length - 1], UNSCREENED_FOOTER);
      const ev = auditEvents(DESC_ACTION)[0].details;
      assert.strictEqual(ev.result, 'shown');
      assert.strictEqual(ev.cause, null);
      assert.strictEqual(ev.common_word_only, false);
    }
  } finally { summaryMod._setScreenForTesting(null); }
  assert.strictEqual(asked, 0, 'the screen was consulted with the switch off');
});

test('U4b the same sensitive texts ARE held with the screen on (so U4a proves something): the real screen holds every one of them but the pass-through list', async () => {
  for (const [name, description] of SENSITIVE_TEXTS) {
    const r = await send({ job: baseJob({ name, description }) });
    assert.deepStrictEqual(blockLines(r.email.text), [HEADER, HELD_NOTICE], `the screen should hold: ${description}`);
  }
  for (const [name, description] of PASS_THROUGH_TEXTS) {
    const r = await send({ job: baseJob({ name, description }) });
    assert.strictEqual(descLine(r.email.text), `  Description: "${description}"`, `pass-through text changed with the screen on: ${description}`);
  }
});

test('U4c a text the screen would hold for its LANGUAGE, scripts, symbols or look-alike letters is shown too, and nothing in the screen module runs', async () => {
  const texts = [
    'Tumutulo ang gripo sa kusina at basa na ang sahig sa banyo kahapon pa po',
    `f${cp(0x131)}x the sink please`, `tenant ${cp(0x267F)} needs help`, `${cp(0x1F930)} knock softly`, `${cp(0x1F691)} at the unit`,
  ];
  for (const description of texts) {
    const held = await send({ job: baseJob({ name: 'Visit', description }) });
    assert.deepStrictEqual(blockLines(held.email.text), [HEADER, HELD_NOTICE], `the screen should hold: ${description}`);
    const r = await sendOff({ job: baseJob({ name: 'Visit', description }) });
    assert.strictEqual(descLine(r.email.text), `  Description: "${description}"`);
  }
});

test('U4d the unscreened path has no reference to the screen, the terms or the pair rules in its source', async () => {
  const src = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-summary.js'), 'utf8');
  const body = src.slice(src.indexOf('function buildUnscreenedSummary'), src.indexOf('module.exports'));
  assert.ok(body.length > 500, 'found the function body');
  for (const word of ['runScreen', 'screenWorkOrderText', 'recordVerdict', 'screenOverride', 'scanText', 'TERMS', 'screen(']) {
    assert.ok(!body.includes(word), `buildUnscreenedSummary mentions ${word}`);
  }
  const cleanSrc = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-clean.js'), 'utf8');
  assert.ok(!/require\(['"]\.\/work-order-text-screen/.test(cleanSrc), 'the cleaner (which holds the mask) does not load the screen');
});

// ════════════════════════════════════════════════════════════════════════
// U5. THE CLEANER'S HYGIENE STAYS
// ════════════════════════════════════════════════════════════════════════
test('U5a links become "[link removed]" and are never shown, in the title and the description', async () => {
  const links = [
    'http://evil.example/login', 'https://evil.example', 'HTTPS://EVIL.EXAMPLE/A', 'www.evil.example', 'evil.zone', 'evil.com/login?x=1', '10.0.0.1', 'bit.ly/abc', 'javascript:alert(1)',
    'ftp://evil.example', 'mailto:x@evil.example', '//evil.example/x', 'user@evil.com/login', 'xn--evil.example', 'evil.co.in',
  ];
  for (const link of links) {
    const r = await sendOff({ job: baseJob({ name: `See ${link}`, description: `Please visit ${link} soon` }) });
    const t = titleLine(r.email.text);
    const d = descLine(r.email.text);
    assert.ok(t.includes(LINK_TEXT) && d.includes(LINK_TEXT), `link not neutralised: ${link}`);
    assert.ok(!/evil\.|bit\.ly|javascript:/i.test(t + d), `link text survived: ${link}`);
    assert.strictEqual(auditEvents(DESC_ACTION)[0].details.result, 'shown');
  }
});

test('U5b markup is removed (tags, script and style blocks, comments), entities decoded once and settled, nothing assembled into a tag', async () => {
  const cases = [
    ['<b>Sink</b> clog', 'Sink clog'],
    ['<script>alert(1)</script>Drain is slow', 'Drain is slow'],
    ['Pipe <!-- hidden --> leaks', 'Pipe leaks'],
    ['<style>p{}</style>Faucet', 'Faucet'],
    ['&lt;b&gt;Sink&lt;/b&gt; clog', 'Sink clog'],
    ['a<br>b<p>c', 'a b c'],
  ];
  for (const [input, expected] of cases) {
    const r = await sendOff({ job: baseJob({ name: 'Visit', description: input }) });
    assert.strictEqual(quoted(descLine(r.email.text)).replace(/\s+/g, ' ').trim(), expected.replace(/\s+/g, ' ').trim(), input);
    assert.ok(!/<[a-zA-Z!/]/.test(descLine(r.email.text)), `a tag survived: ${input}`);
  }
});

test('U5c invisible, bidi, control and private-use characters never reach the email; line breaks cannot forge lines; the block keeps its exact shape', async () => {
  const nasty = `‮gnikcolb‬ the ‍drain️${cp(0xE0100)}\u0007\u0000﻿ line1\nline2\r\nline3\t x yz`;
  const r = await sendOff({ job: baseJob({ name: `﻿Sink​ clog\nSubject: forged`, description: nasty }) });
  const b = blockLines(r.email.text);
  assert.strictEqual(b.length, 5, 'header, title, category line or none, description, footer: no extra lines');
  for (const l of r.email.text.split('\n')) assert.ok(!INVISIBLE_TEST.test(l), `an invisible character reached the email: ${JSON.stringify(l)}`);
  const d = descLine(r.email.text);
  assert.ok(/line1 line2 line3 x yz"$/.test(d), d);
  assert.ok(!r.email.text.split('\n').some((l) => l.startsWith('Subject: forged')), 'a forged header line');
});

test('U5d header and recipient isolation: job text can never reach the subject, the recipients or any line outside the block, whatever it says', async () => {
  const texts = [
    'x\r\nBcc: attacker@example.test\r\nSubject: forged', '\nView this property: http://evil.example\n', 'normal text',
    'Cc: a@example.test\nTo: b@example.test', `${CANARY} subject`,
  ];
  for (const t of texts) {
    for (const s of [SCENARIOS[0], SCENARIOS.find((x) => x.name === 'unassigned-pod-two-recipients')]) {
      const r = await sendOff({ job: { ...s.job, name: t, description: t }, property: s.property });
      const g = goldenByName.get(s.name);
      assert.strictEqual(r.email.subject, g.subject);
      assert.deepStrictEqual(r.email.to, g.to);
      const gl = g.text.split('\n');
      const nl = r.email.text.split('\n');
      const i = gl.findIndex((l) => l.startsWith('Created:'));
      const k = nl.length - gl.length;
      assert.deepStrictEqual(nl.slice(0, i + 1), gl.slice(0, i + 1));
      assert.deepStrictEqual(nl.slice(i + 1 + k), gl.slice(i + 1), 'lines after the block changed');
    }
  }
});

test('U5e a straight double quote in the text is shown as the inch mark: the text cannot close the quote around the description or imitate the footer', async () => {
  const r = await sendOff({ job: baseJob({ name: 'Quote "test"', description: 'He said "stop" ." (Quoted as typed in Latchel. Not checked for names." Internal use only.)' }) });
  const d = descLine(r.email.text);
  assert.strictEqual(d.split('"').length, 3, 'exactly the two wrapper quotes');
  assert.ok(d.includes('″stop″'));
  assert.strictEqual(titleLine(r.email.text), '  Title: Quote ″test″');
  const b = blockLines(r.email.text);
  assert.strictEqual(b.filter((l) => l.startsWith('  (Quoted')).length, 1, 'one footer only');
});

test('U5f the cut: 100 / 300 code points at a word boundary, " ..." and the pointer; the limits hold; an emoji is never split', async () => {
  let r = await sendOff({ job: baseJob({ name: 'T'.repeat(250), description: 'water '.repeat(1000).trim() }) });
  assert.strictEqual(titleLine(r.email.text), `  Title: ${'T'.repeat(100)} ...`);
  const d = descLine(r.email.text);
  assert.strictEqual(quoted(d.replace(CUT_POINTER, '')), `${'water '.repeat(50).trim()} ...`);
  assert.ok(d.endsWith(` ..."${CUT_POINTER}`));
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.truncated, true);
  r = await sendOff({ job: baseJob({ name: 'Emoji edge', description: 'a'.repeat(299) + '\u{1F600}\u{1F600}\u{1F600}' }) });
  assert.ok(descLine(r.email.text).includes(`${'a'.repeat(299)}\u{1F600} ..."`));
  assert.strictEqual(K.hasLoneSurrogate(r.email.text), false);
  r = await sendOff({ job: baseJob({ name: 'Short', description: 'Short.' }) });
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.truncated, false);
  assert.ok(!r.email.text.includes(' ...'));
});

test('U5g a sentence typed with no space after its full stop (the shape the screen-on path HOLDS the block for) is NOT a hold: the token is replaced and the rest is shown', async () => {
  const description = 'Toilet keeps running after every flush.Support the tank lid, it is loose.';
  const on = await send({ job: baseJob({ name: 'Toilet running', description }) });
  assert.deepStrictEqual(blockLines(on.email.text), [HEADER, HELD_NOTICE]);
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.cause, 'link_shape');
  const r = await sendOff({ job: baseJob({ name: 'Toilet running', description }) });
  assert.strictEqual(descLine(r.email.text), `  Description: "Toilet keeps running after every ${LINK_TEXT} the tank lid, it is loose."`);
  const ev = auditEvents(DESC_ACTION)[0].details;
  assert.strictEqual(ev.result, 'shown');
  assert.strictEqual(ev.cause, null);
  for (const t of ['Leaking.Info needed', '8:30.Today only', 'Call me.Work starts Monday']) {
    const q = await sendOff({ job: baseJob({ name: 'Visit', description: t }) });
    assert.ok(descLine(q.email.text).includes(LINK_TEXT), t);
    assert.strictEqual(auditEvents(DESC_ACTION)[0].details.result, 'shown');
  }
});

test('U5h a web-like fragment left by the 300-character cut is replaced, not held; the 100 / 300 limits still hold (the replacement is longer than the fragment)', async () => {
  // one unbroken run, so the cut is a hard cut that ends inside "x.co" (a listed ending)
  const description = `${'a'.repeat(295)},x.coder`;
  const on = await send({ job: baseJob({ name: 'Visit', description }) });
  assert.deepStrictEqual(blockLines(on.email.text), [HEADER, HELD_NOTICE], 'screen on: held');
  const r = await sendOff({ job: baseJob({ name: 'Visit', description }) });
  const d = descLine(r.email.text);
  assert.ok(!/\.co/.test(d), 'the fragment must not be shown');
  const text = quoted(d.replace(CUT_POINTER, ''));
  assert.ok(Array.from(text).length <= DESCRIPTION_MAX + 4, `description is ${Array.from(text).length} characters`);
  assert.ok(d.endsWith(CUT_POINTER));
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.result, 'shown');
  // a fragment inside the title as well
  const t = await sendOff({ job: baseJob({ name: `${'b'.repeat(95)},x.coder`, description: 'fine' }) });
  const tl = titleLine(t.email.text);
  assert.ok(!/\.co/.test(tl));
  assert.ok(Array.from(tl.slice('  Title: '.length)).length <= TITLE_MAX + 4);
});

test('U5i a link that exists only in the NFKC reading (the ordinal mark folds to a letter) is replaced, not held', async () => {
  const description = 'visit evil.cºm or evil.cªm now';
  assert.ok(hasFoldedLink('evil.cºm'));
  const on = await send({ job: baseJob({ name: 'Visit', description }) });
  assert.deepStrictEqual(blockLines(on.email.text), [HEADER, HELD_NOTICE]);
  const r = await sendOff({ job: baseJob({ name: 'Visit', description }) });
  const d = descLine(r.email.text);
  assert.ok(d.includes(LINK_TEXT));
  const shown = quoted(d);
  assert.ok(!containsLink(shown) && !hasFoldedLink(shown) && !containsLink(shown.normalize('NFKC')), shown);
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.result, 'shown');
  // an ordinary Spanish ordinal mark keeps its form when nothing is wrong
  const o = await sendOff({ job: baseJob({ name: '1º piso', description: 'Fuga en el 2º piso, baño' }) });
  assert.strictEqual(titleLine(o.email.text), '  Title: 1º piso');
  assert.strictEqual(descLine(o.email.text), '  Description: "Fuga en el 2º piso, baño"');
});

test('U5j text that will not settle in the cleaner (deeply nested entities) is not held: the neutral line, its own cause, one constant log line, status unavailable', async () => {
  const description = `Faucet drips. &${'amp;'.repeat(9)}lt;b&${'amp;'.repeat(9)}gt; ${CANARY}`;
  const on = await send({ job: baseJob({ name: 'Visit', description }) });
  assert.deepStrictEqual(blockLines(on.email.text), [HEADER, HELD_NOTICE]);
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.cause, 'unsettled_text');
  const r = await sendOff({ job: baseJob({ name: 'Visit', description }) });
  assert.deepStrictEqual(blockLines(r.email.text), [UNAVAILABLE_LINE]);
  const ev = auditEvents(DESC_ACTION)[0];
  assert.strictEqual(ev.details.result, 'unavailable');
  assert.strictEqual(ev.details.cause, 'unprintable_text');
  assert.strictEqual(ev.risk_level, 'medium');
  assert.strictEqual(r.result.action, 'sent');
  assert.ok(!everythingExceptBody(r.email).includes(CANARY), 'no text in any log, write or failure email');
  assert.strictEqual(H.logs.filter((l) => l.includes('unprintable_text')).length, 1, 'one constant line');
  // a non-text value is the same safety fallback
  for (const v of [42, true, { a: 1 }, ['x']]) {
    const q = await sendOff({ job: baseJob({ name: 'Real title here', description: v }) });
    assert.deepStrictEqual(blockLines(q.email.text), [UNAVAILABLE_LINE]);
    assert.strictEqual(auditEvents(DESC_ACTION)[0].details.cause, 'unprintable_text');
  }
});

test('U5k both fields empty or blank: the one explanatory line (as before); title only / description only; a title that is just the start of the description is not repeated', async () => {
  for (const [name, description] of [['', ''], ['   ', '\n\t '], [null, null], [undefined, null]]) {
    const r = await sendOff({ job: baseJob({ name, description }) });
    assert.deepStrictEqual(blockLines(r.email.text), [NONE_LINE]);
    assert.strictEqual(auditEvents(DESC_ACTION)[0].details.result, 'none');
  }
  let r = await sendOff({ job: baseJob({ name: 'Replace hallway light bulb', description: null }) });
  assert.ok(blockLines(r.email.text).includes(`  Description: ${NO_DESCRIPTION}`));
  r = await sendOff({ job: baseJob({ name: '', description: 'Back gate latch is loose.' }) });
  assert.ok(!titleLine(r.email.text));
  r = await sendOff({ job: baseJob({ name: 'Garbage disposal jammed', description: 'garbage disposal jammed and humming, will not turn' }) });
  assert.ok(!titleLine(r.email.text));
});

test('U5l priority comes only from Latchel\'s booleans, the category line is the keyword guess; neither depends on the screen switch', async () => {
  const job = baseJob({ name: 'Leaking kitchen faucet', description: 'Faucet drips constantly under the sink since Monday morning.', is_urgent: true });
  const on = await send({ job });
  const off = await sendOff({ job });
  const strip = (r) => blockLines(r.email.text).slice(0, -1);
  assert.deepStrictEqual(strip(off), strip(on));
  assert.ok(strip(off).includes('  Priority: Urgent (flagged in Latchel)'));
  assert.ok(strip(off).includes('  Category (auto-sorted guess): Plumbing'));
});

// ════════════════════════════════════════════════════════════════════════
// U6. THE NEVER-STORE MASK, BOTH DIRECTIONS
// ════════════════════════════════════════════════════════════════════════
const M = MASK_TEXT;
const MASKED = [
  // Social Security numbers
  ['SSN 123-45-6789 for the tenant', `SSN ${M} for the tenant`], ['ID 123 45 6789.', `ID ${M}.`], ['123-45-6789', M], ['ssn: 123456789', `ssn: ${M}`],
  ['social security number is 123456789 ok', `social security number is ${M} ok`], ['my social is 123-45-6789', `my social is ${M}`], ['seguro social 123 45 6789', `seguro social ${M}`],
  [`SSN ${cp(0x661, 0x662, 0x663)}-${cp(0x664, 0x665)}-${cp(0x666, 0x667, 0x668, 0x669)}`, `SSN ${M}`], ['ssn 123–45–6789', `ssn ${M}`],
  // payment cards
  ['card 4111 1111 1111 1111 exp 12/27 cvv 123', `card ${M} exp 12/27 cvv ${M}`], ['visa: 4111111111111111', `visa: ${M}`], ['pay with 4242-4242-4242-4242 please', `pay with ${M} please`],
  ['My amex is 378282246310005.', `My amex is ${M}.`], ['amex 3782 822463 10005', `amex ${M}`], ['Ref 4012888888881881 done', `Ref ${M} done`], ['mastercard 5555555555554444', `mastercard ${M}`],
  ['credit card number: 4111111111111112', `credit card number: ${M}`], ['tarjeta 4111111111111112', `tarjeta ${M}`], ['card 4111 1111 1111 1112 done', `card ${M} done`], ['csc 123', `csc ${M}`], ['cvc: 1234', `cvc: ${M}`],
  // bank, routing, IBAN, SWIFT
  ['bank account number: 1234567890, routing 021000021', `bank account number: ${M}, routing ${M}`], ['acct# 998877665544', `acct# ${M}`], ['cuenta 12345678901', `cuenta ${M}`],
  ['account is 123456', `account is ${M}`], ['aba 021000021', `aba ${M}`], ['routing no. 02100 0021', `routing no. ${M}`], ['iban GB82 WEST 1234 5698 7654 32', `iban ${M}`],
  ['swift code DEUTDEFF500', `swift code ${M}`], ['BIC code: DEUTDEFF', `BIC code: ${M}`], ['swift number abcdef12', `swift number ${M}`],
  // passwords
  ['password: Hunter22!', `password: ${M}`], ['The wifi password is Rincon2024', `The wifi password is ${M}`], ['pwd=abc123', `pwd=${M}`], ['contrasena: Sol1234', `contrasena: ${M}`],
  ['contraseña es Perro88', `contraseña es ${M}`], ['passcode 4455', `passcode ${M}`], ['PASSWORD: Secret', `PASSWORD: ${M}`], ['password "my big secret" thanks', `password ${M} thanks`],
  ['password hunter2.', `password ${M}.`], ['Password - hunter2', `Password - ${M}`], ['passwd: x', `passwd: ${M}`], ['passphrase is blue-sky-42', `passphrase is ${M}`],
  ['password: [link removed]', `password: ${M}`], ['wifi password: Dog$2024, router 192', `wifi password: ${M}, router 192`],
  // several in one text
  ['SSN 123-45-6789, card 4111 1111 1111 1111, account 123456789012, routing 021000021, password: abc12', `SSN ${M}, card ${M}, account ${M}, routing ${M}, password: ${M}`],
];

test('U6a the mask replaces SSNs, card numbers (and security codes), bank / routing / IBAN / SWIFT numbers introduced by their word, and passwords', async () => {
  for (const [input, expected] of MASKED) {
    assert.strictEqual(maskNeverStore(input), expected, `input: ${input}`);
  }
  assert.ok(MASKED.length >= 45, `${MASKED.length} masked cases`);
  process.stdout.write(`      (${MASKED.length} strings the mask must change, each to the exact expected text)\n`);
});

test('U6b it is idempotent and pure: mask(mask(x)) equals mask(x); non-text and empty input come back unchanged', async () => {
  for (const [input] of MASKED) {
    const once = maskNeverStore(input);
    assert.strictEqual(maskNeverStore(once), once, `not idempotent: ${input}`);
    assert.strictEqual(cleanTextUnscreened(input), cleanTextUnscreened(cleanTextUnscreened(input)), `the whole unscreened cleaning is not idempotent: ${input}`);
  }
  for (const v of ['', undefined, null, 42]) assert.strictEqual(maskNeverStore(v), v);
});

test('U6c through the whole path: the title and the description are masked in the email, the rest is shown, and nothing else is touched (phone, e-mail, name, gate code, ticket, unit, dollars, date)', async () => {
  const description = 'Maria Lopez (maria@example.com, 951-555-1234) gave SSN 123-45-6789, card 4111 1111 1111 1111, account 123456789012, routing 021000021. Wi-Fi password: Hunter22!. Gate code 2040, unit 5B, ticket 483921, $1,250.00 due 10/17/2026.';
  const r = await sendOff({ job: baseJob({ name: 'Card 4111111111111111 on file, SSN 123-45-6789', description }) });
  assert.strictEqual(titleLine(r.email.text), `  Title: Card ${M} on file, SSN ${M}`);
  assert.strictEqual(descLine(r.email.text), `  Description: "Maria Lopez (maria@example.com, 951-555-1234) gave SSN ${M}, card ${M}, account ${M}, routing ${M}. Wi-Fi password: ${M}. Gate code 2040, unit 5B, ticket 483921, $1,250.00 due 10/17/2026."`);
  const everything = r.email.text + everythingExceptBody(r.email);
  for (const secret of ['123-45-6789', '4111 1111 1111 1111', '4111111111111111', '123456789012', '021000021', 'Hunter22']) {
    assert.ok(!everything.includes(secret), `${secret} reached the email or a log`);
  }
});

test('U6d a number that becomes a card number only because of the 300-character cut is masked on the CUT text too (the cut text is cleaned and masked again)', async () => {
  // one unbroken token: the full digit run is 21 digits (not a card), the hard cut at 300 leaves exactly the 16-digit valid number
  const description = `${'a'.repeat(284)}4111111111111111${'9'.repeat(5)}`;
  assert.strictEqual(maskNeverStore(description), description, 'in the full text it is not a card number');
  const r = await sendOff({ job: baseJob({ name: 'Visit', description }) });
  const d = descLine(r.email.text);
  assert.ok(!d.includes('4111111111111111'), 'the cut left a whole card number');
  assert.ok(d.includes(`${'a'.repeat(284)}${M}`), d.slice(0, 120));
  assert.ok(d.endsWith(` ..."${CUT_POINTER}`));
});

// ════════════════════════════════════════════════════════════════════════
// U7. THE MASK'S FALSE-POSITIVE CORPUS
// ════════════════════════════════════════════════════════════════════════
const ORDINARY = [
  'Ticket 123456 unit 5B $1,234.56 on 10/17/2026', 'Call 951-555-1234 or 9515551234 or (951) 555-1234 or 951.555.1234 or +1 951 555 1234', 'Ticket #483921 for unit 12, job 7001 and order 9001',
  'units 101 102 103 104 105', 'Apt 201 202 203 204 205 206', 'order 1234567890123 serial 99887766', 'Tracking 1Z999AA10123456784', 'Serial number SN-4455-8812-0034 on the water heater',
  'Model WH50T10 serial 0912345678 installed 2019-04-12', 'account 951-555-1234', 'account 2024-10-17', 'account 10-17-2026', 'routing the pipe 12 feet', 'routing around the wall studs',
  'gate code 2040 lockbox 1234', 'alarm code 4455 garage 90210', 'email john@example.com name John Smith', 'ZIP 92507 or 92507-1234', 'Paid $1,250.00 and $12,500,000 total',
  'Arrived 10:30 left 11:45, back 2026-10-17 14:30', 'The A/C unit 12345 is at 123 Main Street Riverside CA 92507', 'Part 1/2 inch x 3/4 inch, 5/8" bolt, 2.5.mm', 'Invoice 20261017 and PO 55501234',
  'Room 214, floor 3, building 12, parking space 45', 'Pay $500 deposit, $75 fee, 3 bedrooms 2 baths 1,200 sq ft', 'Lease 2026-2027 ends 06/30/2027, rent 2450', 'Case number 26-CV-123456',
  'phone 9515551234 ext 55', 'tel: 951 555 1234', 'call 800-555-0100', 'UPC 012345678905 on the box', 'EAN 4006381333931', 'VIN-less trailer plate 8ABC123',
  'The password reset email never came', 'Tenant forgot the portal password. Needs reset.', 'password for the portal', 'password is wrong', 'password protected PDF', 'passwords are not working',
  'password is incorrect', 'password manager installed', 'Wifi password does not work', 'password expired yesterday', 'Please reset the password', 'password has been changed',
  'the account balance is $350.00', 'account closed last month', 'tenant account was credited', 'accounting department called', 'Owner account statement attached', 'bank account', 'routing number', 'account number',
  'card reader broken', 'key card does not work', 'gate card 12345', 'credit card machine in the office', 'card 12345', 'Visa required for the tenant?', 'the visa expired', 'card holder needs a new fob',
  'swift response needed', 'swift repairs please', 'swift code response', 'the SWIFT reply was fast', 'iban is a bank code', 'cvv is the security code',
  'social media post', 'social security', 'social worker called', 'social 12345', 'ssn is private', 'Social distancing', 'cuenta con 3 recamaras', 'la cuenta esta cerrada',
  'Fuga en el 2º piso, baño', 'Replace 2½ inch copper pipe', 'Pipe under the 5² ft laundry room is leaking', 'Call me.Work starts Monday',
  'Replace the kitchen faucet, dead bolt sticks, minor leak under the sink', 'Window blinds are broken and the outlet is dead', 'ice maker not working', 'half inch 1/2 fitting under the sink-side cabinet',
  '12345678 is the work order and 87654321 the PO', 'ref 11111111 22222222', 'invoice 4111 1111 1111 111', 'Ref 4111 1111 1111 1112 done',
  'dispatch ids 482910 482911 482912 482913', 'Tenant in 12B asked about parking spot 33, call 626-555-0144 after 5pm', 'Replace GFCI outlet in bath, 20 amp, circuit 14, panel box 2',
  'Smoke detector model 4120 serial 220118734 needs a new battery', 'Water heater 40 gal, installed 2014, tag 9988776', 'Appointment 10/20 between 9-12, vendor job 5001, PO 77120',
  'Rent $2,450.00 due on the 1st, late fee $50 after the 5th', 'See photos 1 2 3 4 5 6 attached', 'Unit 4C 4D 4E 4F 4G all have the same leak', 'ZIP 90210 phone 310 555 0100 ext 4',
  'Garage door opener code 1 2 3 4, remote 5 button', 'invoice 20261017-0042 for $318.75', 'Reference # 8847-2210 for the HVAC filter order', 'Lockbox 4455 on the side gate',
  'Meter number 0044 5566 7788 reading 1024', 'Checked at 08:15 and again at 14:40 on 2026-10-17', 'Case 2026-1234 opened by the city, inspection 55-66-77',
  'Bedroom 12 x 14, closet 3 x 4, ceiling height 8 ft 6 in', 'Part number 3/4-14 NPT x 12, qty 6, $4.25 each', '1 2 3 4 5 6 7 8 9 10 11 12 13 14 15', 'pages 1-2-3-4-5-6-7-8-9-10-11-12-13-14',
];

test('U7a the false-positive corpus: ordinary maintenance text with ticket, unit, phone, dollar, date, serial and part numbers, and everyday uses of the keyword words, is left exactly as typed', async () => {
  const wrong = ORDINARY.filter((s) => maskNeverStore(s) !== s).map((s) => `${s}  =>  ${maskNeverStore(s)}`);
  assert.deepStrictEqual(wrong, [], `the mask changed ordinary text:\n${wrong.join('\n')}`);
  assert.ok(ORDINARY.length >= 100);
  // and through the whole path nothing about them changes either, apart from the footer (see U17)
  for (const s of ORDINARY.slice(0, 20)) {
    assert.strictEqual(cleanTextUnscreened(s), cleanMod.cleanText(s));
  }
  process.stdout.write(`      (${ORDINARY.length} ordinary strings, 0 changed by the mask)\n`);
});

test('U7b generated false-positive checks: ticket / unit / order numbers of 4 to 12 digits after their word, random non-check-digit numbers of 13 to 19 digits, dates and phone numbers are never masked', async () => {
  const next = rng(20261017);
  const rnd = (n) => Array.from({ length: n }, () => String(Math.floor(next() * 10))).join('');
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const len = 4 + Math.floor(next() * 9);
    const word = ['ticket', 'unit', 'order', 'job', 'PO', 'invoice', 'work order', 'ref', 'case', 'part'][i % 10];
    const s = `${word} ${rnd(len)} please`;
    assert.strictEqual(maskNeverStore(s), s, s);
    checked++;
  }
  for (let i = 0; i < 600; i++) {
    const len = 13 + (i % 7);
    let n = rnd(len);
    while (K_luhn(n)) n = rnd(len);
    const s = `Ref ${n} done`;
    assert.strictEqual(maskNeverStore(s), s, s);
    checked++;
  }
  for (let i = 0; i < 200; i++) {
    const phone = `${200 + Math.floor(next() * 700)}${['-', ' ', '.'][i % 3]}${200 + Math.floor(next() * 700)}${['-', ' ', '.'][i % 3]}${rnd(4)}`;
    const s = `Call ${phone} or account ${phone}`;
    assert.strictEqual(maskNeverStore(s), s, s);
    const date = `20${rnd(2)}-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
    const d = `Done ${date} and account ${date}`;
    assert.strictEqual(maskNeverStore(d), d, d);
    checked += 2;
  }
  assert.ok(checked >= 1400);
});

function K_luhn(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

test('U7c generated true positives: every 13 to 19 digit number with a valid check digit, in one group or written the way a card is, every separated SSN, and every keyword-introduced account number of 6 or more digits is masked', async () => {
  const next = rng(171026);
  const rnd = (n) => Array.from({ length: n }, () => String(Math.floor(next() * 10))).join('');
  const luhnOf = (len) => {
    const body = rnd(len - 1);
    for (let d = 0; d < 10; d++) if (K_luhn(body + d)) return body + d;
    throw new Error('no check digit');
  };
  let checked = 0;
  for (let i = 0; i < 700; i++) {
    const len = 13 + (i % 7);
    const n = luhnOf(len);
    assert.strictEqual(maskNeverStore(`Ref ${n} done`), `Ref ${M} done`, n);
    checked++;
  }
  for (let i = 0; i < 300; i++) {
    const n = luhnOf(16);
    const sep = [' ', '-'][i % 2];
    const grouped = `${n.slice(0, 4)}${sep}${n.slice(4, 8)}${sep}${n.slice(8, 12)}${sep}${n.slice(12)}`;
    assert.strictEqual(maskNeverStore(`Ref ${grouped} done`), `Ref ${M} done`, grouped);
    const amex = luhnOf(15);
    const a = `${amex.slice(0, 4)} ${amex.slice(4, 10)} ${amex.slice(10)}`;
    assert.strictEqual(maskNeverStore(`Ref ${a} done`), `Ref ${M} done`, a);
    checked += 2;
  }
  for (let i = 0; i < 300; i++) {
    const a = rnd(3); const b = rnd(2); const c = rnd(4);
    const sep = [' ', '-'][i % 2];
    assert.strictEqual(maskNeverStore(`Id ${a}${sep}${b}${sep}${c} ok`), `Id ${M} ok`);
    assert.strictEqual(maskNeverStore(`ssn ${a}${b}${c} ok`), `ssn ${M} ok`);
    assert.strictEqual(maskNeverStore(`Id ${a}${b}${c} ok`), `Id ${a}${b}${c} ok`, 'nine digits with no word and no separators are not an SSN');
    checked += 3;
  }
  for (let i = 0; i < 300; i++) {
    const n = rnd(6 + (i % 12));
    const kw = ['account', 'acct', 'routing', 'aba', 'cuenta', 'account number', 'bank account number is', 'routing number:'][i % 8];
    assert.strictEqual(maskNeverStore(`${kw} ${n} ok`), `${kw} ${M} ok`, `${kw} ${n}`);
    checked++;
  }
  assert.ok(checked >= 2400, `${checked}`);
});

// ════════════════════════════════════════════════════════════════════════
// U8. THE MASK'S KNOWN LIMITS (what it does NOT catch; the SPEC lists the same)
// ════════════════════════════════════════════════════════════════════════
const NOT_CAUGHT = [
  ['deposit to 123456789012 today', 'an account number with no keyword'],
  ['acct 12345', 'a bank account of fewer than six digits'],
  ['ssn ending 6789', 'the last four digits of a Social Security number'],
  ['Id 123456789 ok', 'nine digits with no separator and no keyword'],
  ['password hunter', 'a plain lowercase word after "password" with no colon, equals sign or "is"'],
  ['password: purple horse battery staple', 'only the first word of an unquoted passphrase with spaces (see the test below)'],
  ['Ref 4111 1111 1111 111 done', 'a card number with a digit missing, no keyword'],
  ['Ref 4111 x 1111 1111 1111 done', 'a card number with something other than a space or a dash inside'],
  [`p${cp(0x430)}ssword: Hunter22`, 'a keyword written with look-alike letters (Cyrillic a)'],
  ['clave: 4455 and pin 4455', 'other words for a code (clave, pin): gate, lockbox and alarm codes pass by the owner\'s decision'],
  ['gate code 2040, alarm 4455', 'access codes (owner decision)'],
  ['call 951-555-1234, mail john@example.com, Maria Lopez', 'phone numbers, e-mail addresses, names (owner decision)'],
  ['my number is one two three four five six seven eight nine', 'digits written as words'],
  ['41111111111111111111', 'a single run of more than 19 digits'],
  ['Mastercard ending in 4444', 'the last four digits of a card'],
  ['rtn 12345', 'a routing number of fewer than six digits'],
];

test('U8 the known limits, pinned: each of these is NOT masked today (the SPEC lists the same limits); a change here must change the SPEC', async () => {
  for (const [input, why] of NOT_CAUGHT) {
    let got = maskNeverStore(input);
    if (input === 'password: purple horse battery staple') {
      assert.strictEqual(got, `password: ${M} horse battery staple`, 'only the first word is masked');
      continue;
    }
    assert.strictEqual(got, input, `now masked (update the SPEC if this is intended): ${why}`);
  }
});

// The other direction, also pinned: the false positives the mask is known to have (ordinary text it masks). They are rare and
// harmless (a "[removed]" where a harmless number was), and the SPEC lists them.
const KNOWN_FALSE_POSITIVES = [
  ['invoice 1111 2222 3333 4444 5555', `invoice ${M} 5555`, 'a 13 to 19 digit number, or one written 4-4-4-4, that happens to pass the card check digit (about 1 in 10 such numbers) though it is a serial or invoice number'],
  ['Ref 4111111111111111 done', `Ref ${M} done`, 'the same for a single group'],
  ['tenant account 483921 is in good standing', `tenant account ${M} is in good standing`, 'a ledger or tenant account number of 6 or more digits after the word "account"'],
  ['card 1234567890123 is jammed in the reader', `card ${M} is jammed in the reader`, 'a number of 13 to 19 digits after the word "card"'],
  ['password is Monday', `password is ${M}`, 'any word after "password is" that is not on the short list of everyday words'],
  ['social 123456789', `social ${M}`, 'nine digits after the word "social"'],
];

test('U8b the known false positives, pinned: these ARE masked today (rare, harmless; the SPEC lists them)', async () => {
  for (const [input, expected] of KNOWN_FALSE_POSITIVES) assert.strictEqual(maskNeverStore(input), expected, input);
});

// ════════════════════════════════════════════════════════════════════════
// U9. THE MASK AGREES WITH THE SCREEN'S OWN SSN AND CARD TEST WHERE THEY OVERLAP
// ════════════════════════════════════════════════════════════════════════
test('U9 every string the screen\'s own pattern calls an SSN or a card number (separated SSN; 13 to 19 digits that pass the check digit, with spaces or dashes) is masked; the screen\'s own start-up must-pass lines are untouched', async () => {
  const next = rng(99);
  const rnd = (n) => Array.from({ length: n }, () => String(Math.floor(next() * 10))).join('');
  const holdsFinancial = (s) => {
    const r = screenMod.screenWorkOrderText({ title: '', description: s });
    return r.status === 'held' && r.categories.includes('financial_id');
  };
  let n = 0;
  for (let i = 0; i < 200; i++) {
    const ssn = `${rnd(3)}-${rnd(2)}-${rnd(4)}`;
    assert.ok(holdsFinancial(`ref ${ssn}`), ssn);
    assert.ok(!/\d{3}-\d{2}-\d{4}/.test(maskNeverStore(`ref ${ssn}`)), ssn);
    let card = rnd(16);
    while (!K_luhn(card)) card = rnd(16);
    const spaced = `${card.slice(0, 4)} ${card.slice(4, 8)} ${card.slice(8, 12)} ${card.slice(12)}`;
    for (const form of [card, spaced]) {
      assert.ok(holdsFinancial(`ref ${form}`), form);
      assert.ok(!/\d{4}/.test(maskNeverStore(`ref ${form}`)), form);
    }
    n += 3;
  }
  for (const line of screenMod._internals.SELF_TEST_MUST_PASS) assert.strictEqual(maskNeverStore(line), line, line);
  process.stdout.write(`      (${n} strings the screen's SSN / card test flags, all masked)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// U10. THE LAST LINE SAYS THE TEXT IS NOT SCREENED
// ════════════════════════════════════════════════════════════════════════
test('U10 the fixed last line: screen on keeps the old wording exactly; screen off says "Not screened" and what is removed, and never claims a check', async () => {
  assert.strictEqual(SHOWN_FOOTER, '  (Quoted as typed in Latchel. Not checked for names, phone numbers or access codes. Internal use only.)');
  assert.strictEqual(UNSCREENED_FOOTER, '  (Quoted from Latchel. Not screened; some links, cards, SSNs, passwords removed. Internal use only.)');
  assert.strictEqual(UNSCREENED_FOOTER.length, 101);
  assert.ok(UNSCREENED_FOOTER.length <= 104, 'at most 104 characters, so the worst-case block Peter accepted (733) does not grow');
  assert.ok(UNSCREENED_FOOTER.length <= SHOWN_FOOTER.length, 'no longer than the old last line');
  assert.ok(/\bsome\b/.test(UNSCREENED_FOOTER), 'the line says SOME are removed, not all');
  assert.ok(!/\b(?:all|every|always)\b|links, cards, bank, SSN and passwords removed/i.test(UNSCREENED_FOOTER), 'no claim that everything is removed');
  const on = await send({ job: baseJob({ name: 'Faucet', description: 'drips' }) });
  const off = await sendOff({ job: baseJob({ name: 'Faucet', description: 'drips' }) });
  assert.strictEqual(blockLines(on.email.text).pop(), SHOWN_FOOTER);
  assert.strictEqual(blockLines(off.email.text).pop(), UNSCREENED_FOOTER);
  assert.ok(!off.email.text.includes('Not checked for names'), 'the old footer must not appear when nothing is screened');
  assert.ok(/not screened/i.test(UNSCREENED_FOOTER) && /internal use only/i.test(UNSCREENED_FOOTER));
  assert.ok(!/cleared|safe|approved|reviewed|verified/i.test(UNSCREENED_FOOTER), 'no word that implies a clearance');
  for (const j of [baseJob({ name: 'x', description: 'y' }), baseJob({ name: '', description: 'only a description' }), baseJob({ name: 'only title', description: '' })]) {
    const r = await sendOff({ job: j });
    const b = blockLines(r.email.text);
    assert.strictEqual(b[b.length - 1], UNSCREENED_FOOTER, 'the footer is always last');
    assert.strictEqual(b.filter((l) => l === UNSCREENED_FOOTER).length, 1);
  }
});

// ════════════════════════════════════════════════════════════════════════
// U11. UNASSIGNED POD
// ════════════════════════════════════════════════════════════════════════
const UNASSIGNED = SCENARIOS.find((s) => s.name === 'unassigned-pod-two-recipients');

test('U11a screen ON, unassigned pod: unchanged, pointer only, nothing read (and no lookup)', async () => {
  const r = await send({ job: { ...UNASSIGNED.job, description: SENSITIVE.description }, property: UNASSIGNED.property });
  assert.deepStrictEqual(blockLines(r.email.text), [HEADER, UNASSIGNED_NOTICE]);
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.cause, 'pod_unassigned');
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.screen_version, SCREEN_VERSION);
});

test('U11b screen OFF, unassigned pod: both inboxes get the text, nothing is held, the missing-pod task and audit rows are unchanged', async () => {
  const r = await sendOff({ job: { ...UNASSIGNED.job, name: 'Locks', description: SENSITIVE.description }, property: UNASSIGNED.property });
  assert.deepStrictEqual(r.email.to, goldenByName.get(UNASSIGNED.name).to, 'both inboxes');
  assert.strictEqual(r.email.to.length, 2);
  assert.strictEqual(descLine(r.email.text), `  Description: "${SENSITIVE.description}"`);
  assert.strictEqual(blockLines(r.email.text).pop(), UNSCREENED_FOOTER);
  assert.ok(!r.email.text.includes(UNASSIGNED_NOTICE));
  const ev = auditEvents(DESC_ACTION)[0];
  assert.strictEqual(ev.details.pod_unassigned, true);
  assert.strictEqual(ev.details.result, 'shown');
  assert.strictEqual(ev.details.cause, null);
  assert.strictEqual(ev.details.screen_version, UNSCREENED_VERSION);
  assert.strictEqual(ev.risk_level, 'medium');
  assert.ok(H.db.writes.some((w) => w.table === 'tasks' && w.payload.title === 'Property missing pod assignment'), 'the missing-pod task is still opened');
  assert.ok(auditEvents('work_order_note_alert.pod_unassigned_flagged').length === 1);
  // everything outside the block is identical to the golden email
  const gl = goldenByName.get(UNASSIGNED.name).text.split('\n');
  const nl = r.email.text.split('\n');
  const i = gl.findIndex((l) => l.startsWith('Created:'));
  const k = nl.length - gl.length;
  assert.deepStrictEqual(nl.slice(0, i + 1), gl.slice(0, i + 1));
  assert.deepStrictEqual(nl.slice(i + 1 + k), gl.slice(i + 1));
});

test('U11c screen OFF, unassigned pod, job without a description key: the read-only lookup is made like any other pod', async () => {
  const job = clone(UNASSIGNED.job);
  delete job.description;
  const r = await sendOff({ job, property: UNASSIGNED.property, before: () => { H.latchelState.getJobImpl = async (id) => ({ job_id: Number(id), name: 'Looked up', description: 'Looked up text.' }); } });
  assert.strictEqual(H.latchelState.getJobCalls.length, 1);
  assert.strictEqual(descLine(r.email.text), '  Description: "Looked up text."');
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.fallback_getjob_used, true);
});

// ════════════════════════════════════════════════════════════════════════
// U12. THE AUDIT ROW
// ════════════════════════════════════════════════════════════════════════
test('U12a the audit row keeps EXACTLY its eleven keys plus trace; the version is the constant "unscreened-owner-override"; the results and causes are the existing ones plus unprintable_text', async () => {
  const cases = [
    [baseJob({ name: 'Faucet', description: 'drips' }), 'shown', null],
    [SENSITIVE, 'shown', null],
    [baseJob({ name: '', description: '' }), 'none', null],
    [baseJob({ name: 'x', description: `&${'amp;'.repeat(9)}lt;b` }), 'unavailable', 'unprintable_text'],
    [baseJob({ name: 42 }), 'unavailable', 'unprintable_text'],
    [(() => { const j = baseJob(); delete j.description; return j; })(), 'unavailable', null],
  ];
  for (const mode of ['shadow', 'on']) {
    for (const [job, result, cause] of cases) {
      await sendOff({ mode, job, before: () => { H.latchelState.getJobImpl = async () => { throw new Error('lookup down'); }; } });
      const evs = auditEvents(DESC_ACTION);
      assert.strictEqual(evs.length, 1);
      const d = evs[0].details;
      assert.deepStrictEqual(Object.keys(d).sort(), AUDIT_KEYS);
      assert.strictEqual(d.screen_version, 'unscreened-owner-override');
      assert.strictEqual(UNSCREENED_VERSION, 'unscreened-owner-override');
      assert.strictEqual(d.result, result);
      assert.strictEqual(d.cause, cause);
      assert.strictEqual(d.common_word_only, false);
      assert.strictEqual(d.mode, mode);
      assert.strictEqual(evs[0].risk_level, 'medium', 'unscreened text is never audited as low');
      assert.ok(d.trace && Object.keys(d.trace).sort().join() === 'parent_span_id,span_id,trace_id');
    }
  }
});

test('U12b no job text, no excerpt, no length, no hash, no matched word and no category name in any audit row, log line, task, alert row or failure email (screen off, text shown)', async () => {
  const names = screenMod.CATEGORY_VOCABULARY;
  const texts = [CANARY, `${CANARY} My husband hit me, SSN 123-45-6789 and password: ${CANARY}x`, `tenant uses a wheelchair ${CANARY}`];
  for (const mode of ['shadow', 'on']) {
    for (const t of texts) {
      const r = await sendOff({ mode, job: baseJob({ name: `T ${t}`, description: t }) });
      const rest = everythingExceptBody(r.email);
      assert.ok(!rest.includes(CANARY), 'job text reached a log, a write or the subject');
      assert.ok(!rest.includes('123-45-6789') && !rest.includes('wheelchair') && !rest.includes('husband'));
      for (const name of names) assert.ok(!rest.includes(`"${name}"`), `category name ${name} recorded`);
      const d = auditEvents(DESC_ACTION)[0].details;
      for (const v of Object.values(d)) assert.ok(!(typeof v === 'string' && /wheelchair|husband|SSN/.test(v)));
      assert.ok(!r.email.subject.includes(CANARY));
    }
  }
  const r = await sendOff({ mode: 'on', job: baseJob({ name: 'Faucet', description: CANARY }) });
  assert.ok(r.email.text.includes(CANARY), 'the sent email is the only copy of the text');
});

test('U12c the audit write for an error path records the unscreened version too (the summary function throwing entirely)', async () => {
  const fake = {
    prepareWorkOrderSummary: async () => { throw new Error(`broken ${CANARY}`); },
    descriptionMode: () => 'on', descriptionModeInfo: () => ({ mode: 'on', downgraded: false }), SCREEN_VERSION: 'x',
    descriptionScreenOn: () => false, UNSCREENED_VERSION: 'unscreened-owner-override',
  };
  const freshA = freshAlert({ stubs: { [path.resolve(H.APPROVAL_DIR, 'lib/work-order-summary.js')]: fake } });
  H.reset();
  H.db.tables.properties.push(clone(baseProperty()));
  const res = await freshA.handleWorkOrderJob(clone(baseJob()), 'webhook');
  assert.strictEqual(res.action, 'sent');
  assertIdenticalToGolden(H.mail.sent[0], 'normal-solimar');
  const ev = auditEvents(DESC_ACTION)[0];
  assert.strictEqual(ev.details.screen_version, 'unscreened-owner-override');
  assert.strictEqual(ev.details.cause, 'summary_error');
  assert.strictEqual(ev.risk_level, 'medium');
  assert.ok(!H.logs.join('\n').includes(CANARY));
});

// ════════════════════════════════════════════════════════════════════════
// U13. NO AI, NO NETWORK
// ════════════════════════════════════════════════════════════════════════
test('U13a with every AI switch turned on and the network blocked, the screen-off path makes no outbound call, builds no model client, over every golden case and a hostile corpus, in shadow and on', async () => {
  const cases = lib.buildCases({ baseJob, baseProperty });
  const hostile = ['<script>fetch("http://x")</script>', 'http://evil.example/a?b=1', 'SSN 123-45-6789', 'x'.repeat(30000), `a${cp(0x202E)}b`, '&amp;'.repeat(100)];
  for (const mode of ['shadow', 'on']) {
    for (const c of cases) {
      await lib.record({ H, alert }, c, baseProperty, (env) => { lib.SETTINGS[mode === 'on' ? 'on' : 'shadow'](env); env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = 'off'; H.setDummyAiEnv(); });
      assert.strictEqual(H.tripwire.calls, 0, `${c.name}: a network call`);
      assert.strictEqual(H.ai.constructed, 0, `${c.name}: a model client`);
    }
    for (const t of hostile) {
      await sendOff({ mode, job: baseJob({ name: t.slice(0, 50), description: t }), before: () => H.setDummyAiEnv() });
      assert.strictEqual(H.tripwire.calls, 0);
      assert.strictEqual(H.ai.constructed, 0);
    }
  }
});

test('U13b the import graph did not grow: the summary loads only the cleaner, the screen and the category table; the cleaner loads nothing; no model SDK anywhere in the three files', async () => {
  const requires = (f) => [...fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib', f), 'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(requires('work-order-summary.js'), ['../../maintenance-history/lib/component-categories', './work-order-text-clean', './work-order-text-screen']);
  assert.deepStrictEqual(requires('work-order-text-clean.js'), []);
  for (const f of ['work-order-summary.js', 'work-order-text-clean.js', 'work-order-notes-alert.js']) {
    const src = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib', f), 'utf8');
    assert.ok(!/@anthropic-ai|anthropic|openai|new Anthropic|fetch\(|https?\.request|net\.connect/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), `${f} mentions a model or a network call in code`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// U14. FAIL-SOFT
// ════════════════════════════════════════════════════════════════════════
test('U14a the unscreened builder throwing something unexpected: the alert is still sent, the neutral line replaces the block, one constant log line, the cause is summary_error, no text anywhere', async () => {
  const lib2 = (f) => path.resolve(H.APPROVAL_DIR, 'lib', f);
  const realClean = require(lib2('work-order-text-clean.js'));
  const broken = { ...realClean, cleanTextUnscreened: () => { throw new Error(`boom ${CANARY}`); } };
  const fresh = H.loadFresh({
    target: lib2('work-order-notes-alert.js'),
    evict: [lib2('work-order-notes-alert.js'), lib2('work-order-summary.js')],
    stubs: { [lib2('work-order-text-clean.js')]: broken },
  });
  H.reset();
  process.env.WORK_ORDER_ALERT_DESCRIPTION_MODE = 'on';
  process.env.WORK_ORDER_ALERT_INGESTION_EXCLUSION_VERIFIED = 'yes';
  process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = 'off';
  H.db.tables.properties.push(clone(baseProperty()));
  const res = await fresh.handleWorkOrderJob(clone(baseJob({ name: 'Faucet', description: 'drips' })), 'webhook');
  assert.strictEqual(res.action, 'sent');
  assert.deepStrictEqual(blockLines(H.mail.sent[0].text), [UNAVAILABLE_LINE]);
  const ev = auditEvents(DESC_ACTION)[0];
  assert.strictEqual(ev.details.cause, 'summary_error');
  assert.strictEqual(ev.details.result, 'unavailable');
  assert.strictEqual(ev.details.screen_version, UNSCREENED_VERSION);
  assert.ok(!H.logs.join('\n').includes(CANARY) && !JSON.stringify(H.db.writes).includes(CANARY));
  assert.strictEqual(H.logs.filter((l) => l.includes('Unexpected error building the description block')).length, 1);
});

test('U14b the summary function throwing entirely, the audit write failing, the mailer failing, a lookup that never answers: the alert goes out (old format when the block is lost) and nothing leaks', async () => {
  // summary throws
  const fake = {
    prepareWorkOrderSummary: async () => { throw new Error(`summary ${CANARY}`); },
    descriptionMode: () => 'on', descriptionModeInfo: () => ({ mode: 'on', downgraded: false }), SCREEN_VERSION: 'x',
    descriptionScreenOn: () => false, UNSCREENED_VERSION: 'u',
  };
  const freshA = freshAlert({ stubs: { [path.resolve(H.APPROVAL_DIR, 'lib/work-order-summary.js')]: fake } });
  H.reset();
  H.db.tables.properties.push(clone(baseProperty()));
  const res = await freshA.handleWorkOrderJob(clone(baseJob()), 'webhook');
  assert.strictEqual(res.action, 'sent');
  assertIdenticalToGolden(H.mail.sent[0], 'normal-solimar');
  assert.ok(!H.logs.join('\n').includes(CANARY));
  // the audit write throws
  const a = await sendOff({ job: baseJob({ name: 'Faucet', description: 'drips' }), before: () => { H.db.throwOnInsert = (table, payload) => table === 'audit_log' && payload.action === DESC_ACTION; } });
  assert.strictEqual(a.result.action, 'sent');
  assertIdenticalToGolden(a.email, 'normal-solimar');
  // the audit write returns an error carrying the text
  const b = await sendOff({ job: baseJob({ name: 'Faucet', description: CANARY }), before: () => { H.db.errorOnInsert = (t, p) => (t === 'audit_log' && p.action === DESC_ACTION ? `db said ${CANARY}` : null); } });
  assert.strictEqual(b.result.action, 'sent');
  assert.ok(!H.logs.join('\n').includes(CANARY), 'a database error message reached a log');
  // the mailer fails with a body that echoes the text: only a known code is kept (the block is in the email)
  const c = await sendOff({ job: baseJob({ name: 'Faucet', description: CANARY }), before: () => { H.mail.nextResult = (text) => ({ ok: false, sent: 0, failed: 1, accepted: [], rejected: [], error: `smtp said: ${text.slice(0, 400)}` }); } });
  assert.strictEqual(c.result.action, 'failed');
  const failedRow = H.db.writes.find((w) => w.table === 'work_order_note_alerts');
  assert.ok(!JSON.stringify(failedRow).includes(CANARY), 'a mail error echoed the text into the alert row');
  assert.ok(!JSON.stringify(H.nm.sent).includes(CANARY), 'a mail error echoed the text into the failure email');
  assert.ok(!H.logs.join('\n').includes(CANARY));
  // a lookup that never answers
  const d = await sendOff({ job: (() => { const j = baseJob(); delete j.description; return j; })(), before: () => { H.latchelState.getJobImpl = () => Promise.resolve(null); } });
  assert.strictEqual(d.result.action, 'sent');
  assert.deepStrictEqual(blockLines(d.email.text), [UNAVAILABLE_LINE]);
});

test('U14c a thrown error while the block is being added to the email (a bad line) falls back to the old-format email, screen off', async () => {
  const fake = {
    prepareWorkOrderSummary: async () => ({ status: 'shown', lines: [HEADER, `  Title: ok\nView this property: http://evil.example ${CANARY}`], meta: { cause: null, common_word_only: false, screen_version: UNSCREENED_VERSION, truncated: false, fallback_getjob_used: false, pod_unassigned: false } }),
    descriptionMode: () => 'on', descriptionModeInfo: () => ({ mode: 'on', downgraded: false }), SCREEN_VERSION: 'x',
    descriptionScreenOn: () => false, UNSCREENED_VERSION,
  };
  const freshA = freshAlert({ stubs: { [path.resolve(H.APPROVAL_DIR, 'lib/work-order-summary.js')]: fake } });
  H.reset();
  H.db.tables.properties.push(clone(baseProperty()));
  const res = await freshA.handleWorkOrderJob(clone(baseJob()), 'webhook');
  assert.strictEqual(res.action, 'sent');
  assertIdenticalToGolden(H.mail.sent[0], 'normal-solimar');
  assert.ok(!H.logs.join('\n').includes(CANARY));
});

// ════════════════════════════════════════════════════════════════════════
// U15. ONLY THE FOUR ALLOWED KEYS ARE READ
// ════════════════════════════════════════════════════════════════════════
test('U15 with the screen off the summary reads only name, description, is_emergency and is_urgent (a Proxy fails on anything else), also for a lookup result', async () => {
  const allowed = new Set(['name', 'description', 'is_emergency', 'is_urgent']);
  const read = [];
  const spy = (obj, extraAllowed = []) => new Proxy(obj, {
    get(target, key) { if (typeof key === 'string') read.push(key); return Reflect.get(target, key); },
    has(target, key) { return Reflect.has(target, key); },
    getOwnPropertyDescriptor(target, key) { return Reflect.getOwnPropertyDescriptor(target, key); },
  });
  const job = spy({ name: 'Faucet', description: 'drips', is_emergency: false, is_urgent: true, access_instructions: CANARY, vendor_description: CANARY, estimate_note: CANARY, tenant_id: 9 });
  process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = 'off';
  const res = await prepareWorkOrderSummary(job, { podUnassigned: false });
  assert.strictEqual(res.status, 'shown');
  assert.ok(read.length > 0);
  for (const k of read) assert.ok(allowed.has(k), `the summary read the forbidden key ${k}`);
  assert.ok(!res.lines.join('\n').includes(CANARY));
  // the lookup result
  read.length = 0;
  const noDesc = spy({ name: 'No description key' });
  delete noDesc.description;
  const looked = spy({ job_id: 5001, name: 'Looked up', description: 'text', is_emergency: true, is_urgent: false, access_instructions: CANARY, vendor_description: CANARY });
  const r2 = await prepareWorkOrderSummary({ name: 'x' }, { jobId: '5001', fetchJob: async () => looked });
  assert.strictEqual(r2.status, 'shown');
  for (const k of read) assert.ok(allowed.has(k) || k === 'job_id' || k === 'id' || k === 'then', `the summary read the forbidden key ${k} of the lookup result`);   // "then": awaiting the answer
  assert.ok(!r2.lines.join('\n').includes(CANARY));
});

// ════════════════════════════════════════════════════════════════════════
// U16. INVARIANTS OVER GENERATED HOSTILE STRINGS
// ════════════════════════════════════════════════════════════════════════
test('U16 5,000 generated hostile strings through the real summary with the screen off: never held, never throws, only plain single lines, nothing link-like, the printed text is clean and masked already (a fixed point), limits hold', async () => {
  const next = rng(1017);
  const pick = (a) => a[Math.floor(next() * a.length)];
  const rnd = (n) => Array.from({ length: n }, () => String(Math.floor(next() * 10))).join('');
  const ATOMS = [
    () => pick(['leak', 'sink', 'Unit', 'water', 'the', 'heater', 'tenant', 'call', 'gate', 'code', 'Kitchen', 'faucet', 'drips', 'Monday', 'please']),
    () => rnd(1 + Math.floor(next() * 20)), () => `${rnd(3)}-${rnd(2)}-${rnd(4)}`, () => `${rnd(4)} ${rnd(4)} ${rnd(4)} ${rnd(4)}`, () => `${rnd(3)}-${rnd(3)}-${rnd(4)}`,
    () => pick(['password:', 'password is', 'pwd=', 'contrasena', 'account', 'acct#', 'routing', 'ssn', 'card', 'iban', 'swift code', 'cvv', 'passcode', 'aba']),
    () => pick(['evil.com', 'a.co', 'Leaking.Info', 'x.coder', 'www.x.y/z', 'http://q', 'evil.cºm', 'user@evil.com', '10.0.0.1', 'bit.ly/a', '//h.example', 'name@example.com', 'a.b']),
    () => pick(['<b>', '</b>', '<script>x</script>', '<!-- c -->', '<<b>b>', '<style>p{}</style>', '<br>', '<a href=x>']),
    () => pick(['&lt;', '&gt;', '&amp;', '&amp;lt;', '&quot;', '&#39;', '&nbsp;', '&amp;amp;amp;lt;b&amp;amp;amp;gt;']),
    () => pick(['​', '‮', '﻿', '️', cp(0xE0100), '\u0007', ' ', '­', cp(0x1F600), '\u0000', '']),
    () => pick(['"', '“', '”', "'", '`']), () => pick(['º', 'ª', '½', '²', '″', '™', '№']),
    () => pick(['\n', '\r\n', '\t', '  ']), () => 'w'.repeat(1 + Math.floor(next() * 120)),
    () => pick(['Subject:', 'Bcc:', 'View this property:', '(Quoted from Latchel.', 'Description:']),
    () => pick(['wheelchair', 'husband', 'undocumented', 'cancer', 'Section 8', '3 day notice', 'white']),
  ];
  const gen = () => {
    const n = 1 + Math.floor(next() * 30);
    let s = '';
    for (let i = 0; i < n; i++) s += pick(ATOMS)() + pick([' ', ' ', ' ', '', ',', '.', '\n']);
    return s;
  };
  process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = 'off';
  const stats = { shown: 0, none: 0, unavailable: 0, held: 0 };
  for (let i = 0; i < 5000; i++) {
    const name = next() < 0.5 ? gen() : '';
    const description = gen();
    const res = await prepareWorkOrderSummary({ name, description, is_urgent: next() < 0.3 });
    stats[res.status]++;
    assert.notStrictEqual(res.status, 'held', `held: ${JSON.stringify({ name, description })}`);
    assert.strictEqual(res.meta.screen_version, UNSCREENED_VERSION);
    assert.ok(res.lines.length >= 1 && res.lines.length <= 6);
    for (const l of res.lines) {
      assert.ok(!/[\r\n]/.test(l) && !INVISIBLE_TEST.test(l), `bad line ${JSON.stringify(l)}`);
      assert.ok(!K.FORBIDDEN_WORDS.test(l) || /undefined|null|NaN|\[object Object\]/.test(JSON.stringify([name, description])), `bad word in ${l}`);
    }
    if (res.status !== 'shown') continue;
    const tl = res.lines.find((l) => l.startsWith('  Title: '));
    const dl = res.lines.find((l) => l.startsWith('  Description: '));
    const parts = [];
    if (tl) parts.push([tl.slice('  Title: '.length), TITLE_MAX]);
    if (dl && dl !== `  Description: ${NO_DESCRIPTION}`) {
      const inner = dl.slice('  Description: "'.length).replace(CUT_POINTER, '');
      parts.push([inner.slice(0, inner.lastIndexOf('"')), DESCRIPTION_MAX]);
    }
    for (const [text, limit] of parts) {
      assert.ok(Array.from(text).length <= limit + 4, `over the limit: ${Array.from(text).length}`);
      assert.ok(!containsLink(text) && !hasFoldedLink(text), `a link-like piece survived: ${JSON.stringify(text)}`);
      assert.strictEqual(maskNeverStore(text), text, `printed text is not masked already: ${JSON.stringify(text)}`);
      assert.strictEqual(cleanTextUnscreened(text), text, `printed text is not a fixed point: ${JSON.stringify(text)}`);
      assert.ok(!K.hasLoneSurrogate(text));
    }
    assert.strictEqual(res.lines[res.lines.length - 1], UNSCREENED_FOOTER);
  }
  assert.strictEqual(stats.held, 0);
  assert.ok(stats.unavailable < 250, `${stats.unavailable} fallbacks out of 5000 (should be rare)`);
  process.stdout.write(`      (5000 strings: ${stats.shown} shown, ${stats.none} none, ${stats.unavailable} neutral fallback, 0 held)\n`);
});

test('U16b hostile size: 20,000 characters of the mask\'s trigger words, digits and separators finish well inside the cleaner\'s time budget, with no error', async () => {
  const shapes = ['account '.repeat(2500), 'password: x1 '.repeat(1500), '4111 '.repeat(4000), '1'.repeat(20000), '12-'.repeat(6600), 'swift code '.repeat(1800), `account ${':'.repeat(19000)}`, 'iban '.repeat(4000), '123-45-6789 '.repeat(1600), 'a '.repeat(10000)];
  for (const s of shapes) {
    const started = process.hrtime.bigint();
    const out = cleanTextUnscreened(s);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms for ${s.slice(0, 12)}`);
    assert.strictEqual(typeof out, 'string');
  }
});

// ════════════════════════════════════════════════════════════════════════
// U17. ORDINARY TEXT: THE SAME BLOCK, ONLY THE LAST LINE DIFFERS
// ════════════════════════════════════════════════════════════════════════
test('U17 for the ordinary texts the screen lets through (every original must-pass string and the mask corpus), the screen-off block equals the screen-on block except for the last line', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'screen-corpus.js'), 'utf8');
  const block = src.slice(src.indexOf('const MUST_PASS = ['), src.indexOf('// ═', src.indexOf('const MUST_PASS = [')));
  const unescape = (t) => t.replace(/\\'/g, "'").replace(/\\u\{([0-9a-fA-F]+)\}/g, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  const originals = [...block.matchAll(/^  '((?:[^'\\]|\\.)*)',$/gm)].map((m) => unescape(m[1]));
  assert.ok(originals.length >= 100);
  let same = 0;
  let screenHeldOnly = 0;
  for (const text of [...originals, ...ORDINARY]) {
    delete process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN;
    const on = await prepareWorkOrderSummary({ name: 'Visit', description: text });
    process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = 'off';
    const off = await prepareWorkOrderSummary({ name: 'Visit', description: text });
    delete process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN;
    assert.strictEqual(off.status, 'shown', text);
    if (on.status !== 'shown') { screenHeldOnly++; continue; }
    assert.deepStrictEqual(off.lines.slice(0, -1), on.lines.slice(0, -1), `the text changed with the screen off: ${text}`);
    assert.strictEqual(off.lines[off.lines.length - 1], UNSCREENED_FOOTER);
    same++;
  }
  assert.ok(same >= 200, `${same} identical blocks`);
  process.stdout.write(`      (${same} ordinary texts: identical blocks except the last line; ${screenHeldOnly} the screen holds on its own words and the switch shows)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// U18. BLOCK LENGTH WITH THE SCREEN OFF
// ════════════════════════════════════════════════════════════════════════
test('U18 the longest possible block with the screen off is worked out from the constants and measured: 730 characters (screen on: 733), never above the 733 Peter accepted', async () => {
  const cat = require(path.resolve(H.HUB_DIR, 'maintenance-history/lib/component-categories'));
  const labelOf = (key) => cat.CATEGORY_LABELS[key];
  const keys = cat.CATEGORY_ORDER.filter((k) => k !== 'other').sort((a, b) => labelOf(b).length - labelOf(a).length).slice(0, summaryMod.MAX_CATEGORY_LABELS);
  const ordered = cat.CATEGORY_ORDER.filter((k) => keys.includes(k));
  const keywordFor = (key) => {
    const words = (cat.CATEGORIES[key] && (cat.CATEGORIES[key].keywords || cat.CATEGORIES[key])) || [];
    const found = [].concat(words).find((w) => typeof w === 'string' && !/[^a-z]/i.test(w) && JSON.stringify(cat.categorize(`${w}`)) === JSON.stringify([key]));
    assert.ok(found, `no single keyword for ${key}`);
    return found;
  };
  const theoretical = (footer) => [
    HEADER,
    `  Title: ${'x'.repeat(TITLE_MAX)} ...`,
    `  Category (auto-sorted guess): ${ordered.map(labelOf).join(', ')}`,
    '  Priority: Emergency / Urgent (flagged in Latchel)',
    `  Description: "${'x'.repeat(DESCRIPTION_MAX)} ..."${CUT_POINTER}`,
    footer,
  ].join('\n').length;
  const kw = ordered.map(keywordFor).join(' ');
  const job = baseJob({ name: `${kw} ${'T'.repeat(TITLE_MAX + 50)}`, description: `${kw} ${'D'.repeat(DESCRIPTION_MAX + 50)}`, is_emergency: true, is_urgent: true });
  const on = await send({ job });
  const off = await sendOff({ job });
  const lenOn = blockLines(on.email.text).join('\n').length;
  const lenOff = blockLines(off.email.text).join('\n').length;
  assert.strictEqual(lenOn, theoretical(SHOWN_FOOTER));
  assert.strictEqual(lenOn, 733, 'the screen-on worst case is unchanged');
  assert.strictEqual(lenOff, theoretical(UNSCREENED_FOOTER));
  assert.ok(lenOff <= 733, 'the screen-off worst case never exceeds the 733 Peter accepted');
  assert.strictEqual(lenOff, 733 - (SHOWN_FOOTER.length - UNSCREENED_FOOTER.length), 'the screen-off worst case is 733 less the difference in the last line (the last line is 101 characters, so 730)');
  assert.strictEqual(lenOff, 730);
  assert.strictEqual(blockLines(off.email.text).length, 6);
  process.stdout.write(`      (WORST CASE with the screen off: ${lenOff} characters over 6 lines (screen on: ${lenOn}); the fixed last line is ${UNSCREENED_FOOTER.length} characters, at most the old 104)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// U19. THE DOCUMENTS SAY WHAT THE CODE DOES
// ════════════════════════════════════════════════════════════════════════
test('U19 .env.example names the switch without setting it; the SPEC and the data inventory describe the switch, the mask, its limits, the version constant, the new cause and the footer', async () => {
  const env = readDoc('.env.example');
  assert.ok(env.includes('WORK_ORDER_ALERT_DESCRIPTION_SCREEN'));
  const lines = env.split('\n').filter((l) => /WORK_ORDER_ALERT_DESCRIPTION_SCREEN/.test(l));
  assert.ok(lines.some((l) => /^#\s*WORK_ORDER_ALERT_DESCRIPTION_SCREEN=\s*$/.test(l)), 'the example line is commented out and has no value');
  assert.ok(!lines.some((l) => /^WORK_ORDER_ALERT_DESCRIPTION_SCREEN=/.test(l)), 'the switch must not be set by the example file');
  const spec = readDoc('projects/hub/work-order-notes-alert-SPEC.md');
  for (const needle of ['WORK_ORDER_ALERT_DESCRIPTION_SCREEN', 'unscreened-owner-override', 'unprintable_text', UNSCREENED_FOOTER.trim(), 'maskNeverStore', 'owner override', 'lowercase']) {
    assert.ok(spec.includes(needle), `the SPEC does not mention: ${needle}`);
  }
  const inv = readDoc('compliance/work-order-note-alerts-data-inventory.md');
  for (const needle of ['WORK_ORDER_ALERT_DESCRIPTION_SCREEN', 'unscreened-owner-override', 'unprintable_text', 'owner']) {
    assert.ok(inv.includes(needle), `the data inventory does not mention: ${needle}`);
  }
  assert.ok(/screen_version[\s\S]{0,400}unscreened-owner-override/.test(spec), 'the SPEC explains the version value in the audit paragraph');
  // round 6: the mask order and the one-pass SSN / card rule, as the code does them
  assert.ok(spec.includes('Social Security by word, account, card by word, security code, SWIFT, passwords, IBAN, then one pass for the separated Social Security number and the card number'), 'the SPEC states the mask order');
  assert.ok(!spec.includes('the card rule runs before the SSN rule'), 'the SPEC no longer describes the old two-rule order');
  assert.ok(/ONE pass/.test(spec) && spec.includes('never two rules'), 'the SPEC says the SSN and the card are one pass');
  assert.ok(/unscreened-owner-override/.test(spec.slice(spec.indexOf('-- 1. Results by day'))), 'the review SQL knows the unscreened rows');
});

runner.run();
