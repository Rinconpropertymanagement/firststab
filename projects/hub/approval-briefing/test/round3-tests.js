#!/usr/bin/env node
/**
 * test/round3-tests.js
 *
 * Tests for the third fix round (after the second round's tester, security,
 * red-team, governance and judge findings on commit ce30374). One test group
 * per condition, named after the condition it proves:
 *
 *   R3-1  the audit row carries no category names (Peter's rule: no protected-class data in any table)
 *   R3-2  any punctuation stands for a space in a shared phrase; the Section 8 rule; the squashed phrase list
 *   R3-3  the link rule: the sentence-break shape holds the block; no ending is exempt; at-signs; units
 *   R3-4  text the cleaner cannot settle has its own cause (not a scanner error)
 *   R3-5  "N day notice" in its written forms, English and Spanish
 *   R3-6  the bounded vocabulary round (wo-supp-v3): direct statements, Spanish parity, slur plurals, symbols
 *   S3-3  the quotes around the description cannot be closed early by the text
 *   R3-8  the documents say what the code does
 *
 * No bypass string and no slur is written out beyond plain test inputs: the
 * punctuation sweeps are built from the live phrase lists, and slur plurals
 * are built from the terms file at run time.
 *
 * Run alone:  node projects/hub/approval-briefing/test/round3-tests.js
 */

const K = require('./test-kit');
const { H, assert, path, clone, baseProperty, baseJob, auditEvents, blockLines, DESC_ACTION, HEADER, HELD_NOTICE } = K;
const fs = require('fs');
const cleanMod = H.load('lib/work-order-text-clean.js');
const screenMod = H.load('lib/work-order-text-screen.js');
const T = H.load('lib/work-order-text-screen-terms.js');
const { prepareWorkOrderSummary, SHOWN_FOOTER } = K.summaryMod;
const { cleanText, cleanTextBoth, containsLink, hasFoldedLink, LINK_TEXT } = cleanMod;
const { screenWorkOrderText } = screenMod;
const sharedTerms = require(path.resolve(H.HUB_DIR, 'maintenance-history/lib/protected-class-terms.js'));
const REPO = path.resolve(H.HUB_DIR, '../..');

const runner = K.makeRunner('Work Order Alert - third fix round');
const { test } = runner;
const cp = (...codes) => String.fromCodePoint(...codes);

/** The real path: cleaner (both readings, and its own hold request) then the screen. */
function full(title, description) {
  return K.screenFull(title, description);
}
const heldFull = (desc, title = '') => full(title, desc).status === 'held';
const readDoc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const APPROVAL = (f) => path.resolve(H.APPROVAL_DIR, f);

// ════════════════════════════════════════════════════════════════════════
// R3-1  NO CATEGORY NAMES IN THE AUDIT ROW (Asimov R3-1, Sentinel S2-C, Judge fix 1)
// ════════════════════════════════════════════════════════════════════════
const AUDIT_KEYS = ['latchel_job_id', 'trigger_source', 'mode', 'result', 'cause', 'common_word_only', 'screen_version', 'truncated', 'fallback_getjob_used', 'pod_unassigned', 'on_downgraded', 'trace'].sort();

test('R3-1a the audit event carries exactly the agreed keys and NO category name, in shadow and on, for a hit in every family of words', async () => {
  const texts = [
    'tenant uses a wheelchair', 'Section 8 voucher holder', 'restraining order against the ex husband', 'su hijo esta enfermo', 'she is pregnant', 'the tenant passed away', 'speaks Spanish only',
    'tenant is a Muslim', 'tenant has a green card', 'got a 3 day notice', 'he was arrested', 'SSN 123-45-6789', 'paint the walls white', 'my husband hit me', 'esta jubilada', 'es madre soltera',
    'tenant is behind on rent', `tenant ${cp(0x267F)}`, 'Tumutulo ang gripo sa kusina at basa na ang sahig sa banyo kahapon pa po', 'Leaking.Info needed', 'domestic\u200Bviolence',
  ];
  const names = screenMod.CATEGORY_VOCABULARY;
  for (const mode of ['shadow', 'on']) {
    for (const description of texts) {
      const r = await K.send({ mode, job: baseJob({ name: 'Visit', description }) });
      const ev = auditEvents(DESC_ACTION);
      assert.strictEqual(ev.length, 1);
      const d = ev[0].details;
      assert.deepStrictEqual(Object.keys(d).sort(), AUDIT_KEYS, `keys for ${description}`);
      assert.ok(!('held_categories' in d));
      assert.strictEqual(d.result, 'held');
      // nothing stored, logged or sent holds a category name as a value
      const everything = JSON.stringify([auditEvents(), H.db.writes, H.logs, H.nm.sent, r.email ? r.email.subject : '']);
      for (const name of names) assert.ok(!everything.includes(`"${name}"`), `category name ${name} stored or logged for: ${description}`);
      const bodyOnly = r.email.text;
      for (const name of names) assert.ok(!bodyOnly.includes(`"${name}"`) && !bodyOnly.includes(`${name}:`), `category name ${name} in the email`);
    }
  }
});

test('R3-1b the summary result carries no category key either, and no code path in the feature can store one', async () => {
  for (const [name, description] of [['Visit', 'tenant uses a wheelchair'], ['Faucet', 'drips'], ['Leaking.Info', 'needed'], ['', '']]) {
    const s = await prepareWorkOrderSummary({ name, description });
    assert.deepStrictEqual(Object.keys(s.meta).sort(), ['cause', 'common_word_only', 'fallback_getjob_used', 'pod_unassigned', 'screen_version', 'truncated']);
  }
  for (const f of ['lib/work-order-summary.js', 'lib/work-order-notes-alert.js']) {
    const code = codeOnly(fs.readFileSync(APPROVAL(f), 'utf8'));
    assert.ok(!/held_categories|\.categories/.test(code), `${f} still reads or writes category names`);
  }
  // the screen itself still knows which kind of word matched (tests and tuning of the list use it), but only in memory
  assert.ok(screenWorkOrderText({ title: '', description: 'tenant uses a wheelchair' }).categories.length > 0);
});

test('R3-1c the documents agree: the shadow-week SQL and the audit key list name no category, and the data inventory says category names are not stored', async () => {
  const spec = readDoc('projects/hub/work-order-notes-alert-SPEC.md');
  assert.ok(!spec.includes('held_categories'), 'the SPEC mentions the removed key');
  assert.ok(!/jsonb_array_elements_text/.test(spec), 'the category query is deleted from the review SQL');
  const inv = readDoc('compliance/work-order-note-alerts-data-inventory.md');
  assert.ok(!inv.includes('held_categories'), 'the data inventory mentions the removed key');
  assert.ok(/no category name/i.test(inv), 'the data inventory says no category name is stored');
});

// ════════════════════════════════════════════════════════════════════════
// R3-2  ANY PUNCTUATION STANDS FOR A SPACE (Asimov R3-2, Viper B1/B2, Judge fix 2)
// ════════════════════════════════════════════════════════════════════════
function sharedMultiWord() {
  const out = [];
  for (const list of Object.values(sharedTerms.CATEGORIES)) for (const term of list) { const t = term.trim(); if (t.includes(' ')) out.push(t); }
  return out;
}
const ctx = (s) => `please check the kitchen sink in the unit, ${s}, thanks`;
/** Held, or the cleaner replaced it as a web address (then the phrase is not shown at all). */
const heldOrHidden = (text) => heldFull(text) || cleanTextBoth(text).shown.includes(LINK_TEXT);

test('R3-2a EVERY multi-word phrase of the shared list with EVERY ASCII punctuation mark and a long list of common symbols in place of the space is held (the sweep that found 2054 slips)', async () => {
  const phrases = sharedMultiWord();
  assert.ok(phrases.length >= 60, `${phrases.length} shared phrases`);
  const marks = [];
  for (let c = 33; c < 127; c++) { const ch = String.fromCharCode(c); if (!/[A-Za-z0-9]/.test(ch)) marks.push(ch); }
  const symbols = [0x2022, 0xB7, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0xA7, 0xB6, 0x2020, 0x2021, 0xA9, 0xAE, 0xB0, 0x20AC, 0xA3, 0xA5, 0xA2, 0xD7, 0xF7, 0xB1, 0xAC, 0xA6, 0xA1, 0xBF, 0xAB, 0xBB,
    0x2192, 0x2190, 0x2194, 0x2713, 0x2714, 0x2717, 0x2605, 0x2606, 0x2665, 0x25A0, 0x25A1, 0x25CF, 0x25CB, 0x25C6, 0x2726, 0x203B, 0x2044, 0x2215, 0x2216, 0x2236, 0xFF0C, 0xFF1A, 0xFF1B, 0xFF0B, 0xFF5C, 0x3001, 0x3002, 0xA0, 0x2003, 0x09, 0x0A].map((c) => cp(c));
  assert.ok(marks.length >= 30 && symbols.length >= 55);
  let n = 0;
  const slips = [];
  for (const phrase of phrases) {
    assert.ok(heldFull(ctx(phrase)), `plain phrase not held: ${phrase}`);
    for (const sep of [...marks, ...symbols]) {
      if (phrase.includes(sep)) continue;
      n++;
      if (!heldOrHidden(ctx(phrase.replace(/ /g, sep)))) slips.push(`${phrase} / U+${sep.codePointAt(0).toString(16)}`);
    }
  }
  assert.deepStrictEqual(slips, [], `${slips.length} of ${n} variants slipped through`);
  process.stdout.write(`      (${phrases.length} shared phrases x ${marks.length} ASCII marks and ${symbols.length} symbols = ${n} variants, 0 slipped through)\n`);
});

// R3-2b (a sweep of every punctuation, symbol and space code point) was replaced in the fourth fix round by R4-1b in round4-tests.js:
// its filter skipped every character that Unicode folds to a letter or digit, which is where the trademark, service-mark and numero signs
// got through, so its "0 slips for every code point" wording overstated what it proved. R4-1b and test/sweep-full.js do not skip them.

test('R3-2c the Section 8 rule: "section", "sec" or "seccion" with 8, eight, viii or ocho within two words, however punctuated; ordinary section and sec wording passes', async () => {
  const hold = ['Section #8 inspection next week', 'Section: 8 inspection', 'Section:8 inspection', 'Section No. 8', 'section (8) inspection', 'Section "8" inspection', 'section ~8 inspection', 'Sec eight inspection',
    'seccion ocho', 'Seccion 8', 'sec. viii voucher', 'Section number eight', 'SECTION - 8', 'section | 8', 'sec/8', 'section\u200B8', 'section<b></b>8'];
  for (const t of hold) { const r = full('', t); assert.strictEqual(r.status, 'held', t); assert.ok(r.categories.includes('source_of_income'), `${t} -> ${r.categories}`); }
  const pass = ['Section 12 of the gate manual', 'section of fence 8 feet long', 'cross section of the duct', 'section 80 of the plan', 'sec 3 of the code', 'the 8 foot section', 'sections of drywall', 'seconds count', 'secure the gate 8 times'];
  for (const t of pass) assert.strictEqual(heldFull(t), false, `held: ${t}`);
});

test('R3-2d the squashed list: about 30 long two-word phrases, each really on the shared or feature list, held when typed as ONE word or glued by invisible characters inside and between the words; no general substring matching', async () => {
  const known = new Set();
  for (const list of Object.values(T.TERMS)) for (const { term } of list) known.add(term.replace(/\*/g, ''));
  for (const list of Object.values(sharedTerms.CATEGORIES)) for (const term of list) known.add(term.trim());
  assert.ok(T.SQUASHED_PHRASES.length >= 28 && T.SQUASHED_PHRASES.length <= 40, `${T.SQUASHED_PHRASES.length} phrases`);
  // pinned: the list as reviewed (removing one is a loosening and needs the same sign-off as removing a term)
  const PINNED = ['restraining order', 'domestic violence', 'domestic abuse', 'protective order', 'protection order', 'unlawful detainer', 'green card', 'border patrol', 'sex offender', 'police report', 'passed away',
    'food stamps', 'housing voucher', 'public assistance', 'mental health', 'mental illness', 'service animal', 'assistance animal', 'emotional support', 'reasonable accommodation', 'immigration status',
    'national origin', 'gender identity', 'sexual orientation', 'marital status', 'domestic partner', 'familial status', 'senior citizen', 'african american', 'native american', 'pacific islander', 'middle eastern', 'skin color'];
  assert.deepStrictEqual(PINNED.filter((p) => !T.SQUASHED_PHRASES.some((x) => x.phrase === p)), [], 'a pinned squashed phrase is missing');
  assert.strictEqual(T.SQUASHED_PHRASES.length, PINNED.length, 'the list has grown or shrunk: update the pinned list on purpose');
  const seen = new Set();
  for (const { phrase, cat } of T.SQUASHED_PHRASES) {
    assert.ok(screenMod.CATEGORY_VOCABULARY.includes(cat));
    assert.strictEqual(phrase.split(' ').length, 2, `two words: ${phrase}`);
    assert.ok(phrase.replace(' ', '').length >= 9 && /^[a-z ]+$/.test(phrase), `nine letters at least: ${phrase}`);
    assert.ok(known.has(phrase), `not on the shared or feature list: ${phrase}`);
    assert.ok(!seen.has(phrase)); seen.add(phrase);
    const [a, b] = phrase.split(' ');
    // typed as one word
    assert.ok(heldFull(`please note ${a}${b} for this unit`), `one word not held: ${phrase}`);
    // glued by an invisible character between the words, and inside the first word as well
    assert.ok(heldFull(`please note ${a}\u200B${b} for this unit`), `glued between not held: ${phrase}`);
    assert.ok(heldFull(`please note ${a.slice(0, 3)}\u200B${a.slice(3)}\u200B${b} for this unit`), `glued inside and between not held: ${phrase}`);
    assert.ok(heldFull(`please note ${a.slice(0, 3)}<b></b>${a.slice(3)}<i></i>${b} for this unit`), `tags inside and between not held: ${phrase}`);
  }
  // no general substring matching: words inside longer words, and phrases that are not on the list, do not hold
  for (const t of ['bypassed the valve', 'tenantispregnant', 'unsafehouse wiring', 'evergreenery', 'greenhouse door', 'domesticated plants', 'foodservice stamps']) {
    assert.strictEqual(screenWorkOrderText({ title: '', description: t }).status, 'cleared', `held: ${t}`);
  }
  process.stdout.write(`      (${T.SQUASHED_PHRASES.length} squashed phrases)\n`);
});

test('R3-2e ordinary text with every kind of punctuation still passes (no new false holds from the word copy)', async () => {
  const pass = ['Kitchen, sink and bath: all leaking', 'Gate code: 2040; call first', 'Unit 4 (rear) needs paint', 'Replace 3/4" valve under the sink', 'Price: $45 + tax | ask for Sam', 'Tel: 805-555-1234 * leave a message',
    'Re: lock change - rear door', 'Items: pipe, elbow, tee, cap & valve', 'Check the A/C [Unit 5] -> thermostat', '#12 Oak St, apt 3', 'Fix by 5pm!!! Thanks', 'The "food" tray light is out', 'Skin-deep scratch on the door',
    'Service panel (200 amp) is full', 'Public works crew at the curb', 'Check the vent behind the unit', 'Marital arts studio sign is loose'];
  for (const t of pass) assert.strictEqual(heldFull(t), false, `held: ${t}`);
});

// ════════════════════════════════════════════════════════════════════════
// R3-3  THE LINK RULE (Asimov R3-3, Sentinel S2-A, Viper B3/B4, Judge fix 3)
// ════════════════════════════════════════════════════════════════════════
test('R3-3a EVERY everyday-word ending: written Title-case right after one plain word it is never shown as typed and the whole block is held; lower case, upper case and a path are plain links', async () => {
  const endings = [...cleanMod.SENTENCE_BREAK_ENDINGS];
  assert.ok(endings.length >= 90);
  const title = (w) => w[0].toUpperCase() + w.slice(1);
  for (const e of endings) {
    const t = `see Rincon.${title(e)} now`;
    const c = cleanTextBoth(t);
    assert.strictEqual(c.shown, `see ${LINK_TEXT} now`, `shown as typed: ${t}`);
    assert.strictEqual(c.ambiguousLink, true, `not held: ${t}`);
    assert.strictEqual(heldFull(t), true);
    for (const variant of [`rincon.${e}`, `Rincon.${e.toUpperCase()}`, `Rincon.${title(e)}/login`, `Rincon.${title(e)}:8080`]) {
      const v = cleanTextBoth(`see ${variant} now`);
      assert.strictEqual(v.shown, `see ${LINK_TEXT} now`, `not a link: ${variant}`);
      assert.strictEqual(v.ambiguousLink, false, `only the Title-case shape asks for a hold: ${variant}`);
    }
  }
  // the abuse-prone endings Sentinel counted (52 of 53 were inside the old exemption)
  for (const e of ['support', 'bank', 'shop', 'store', 'online', 'site', 'live', 'click', 'link', 'work', 'top', 'pay', 'cash', 'zip', 'cloud', 'money', 'club', 'app', 'help', 'email']) {
    assert.ok(heldFull(`Chase.${title(e)} needs a callback`), e);
  }
  process.stdout.write(`      (${endings.length} endings, each held when Title-case and replaced in every other shape)\n`);
});

test('R3-3b an at-sign with no name before it, and a doubled at-sign, are not plain e-mail addresses; real addresses are left alone', async () => {
  const links = ['@evil.zone', ' @evil.zone', '(@evil.zone)', '!@evil.zone', '-@evil.zone', '.@evil.zone', '@@evil.zone', 'x@@evil.zone', 'a@b@evil.zone', 'x @evil.zone'];
  for (const l of links) {
    const out = cleanText(`call ${l} now`);
    assert.ok(out.includes(LINK_TEXT), `domain not neutralised: ${l} -> ${out}`);
    assert.strictEqual(containsLink(out), false);
  }
  for (const k of ['ceo@evil.zone', 'john.smith@example.com', 'a_b-c.d@e-f.test', "o'brien@example.com", 'x1@sub.example.co.uk', 'sales@example.com.']) assert.strictEqual(cleanText(`mail ${k}`), `mail ${k}`, `mangled: ${k}`);
  // a plain address with a path or port after the domain is still a link
  assert.ok(cleanText('mail ceo@evil.zone/login').includes(LINK_TEXT));
});

test('R3-3c units written like domains: only measurement endings after a number are left alone; every other ending after a number is a web address', async () => {
  for (const k of ['drill a 5.mm hole', 'add 6.ml of sealant', 'about 3.cm wide', 'weighs 10.kg', 'use a 2.5.mm bit', 'add 1500.ml', 'at 9.am and 5.pm', '12.lb bag', '3.km away']) assert.strictEqual(cleanText(k), k, `mangled: ${k}`);
  for (const l of ['12345.tk', '99.ws', '1688.cc', '2023.io', '123456.ml', 'login.12345.tk', '8.co', '77.me', '5.ly', '5.gl']) {
    assert.ok(cleanText(`see ${l} now`).includes(LINK_TEXT), `not neutralised: ${l}`);
  }
  assert.ok(cleanMod.UNIT_ENDINGS.size <= 12 && [...cleanMod.UNIT_ENDINGS].every((u) => u.length === 2));
});

test('R3-3d the everyday two-letter endings: a hyphenated word before one is a link; written Title-case like a sentence start it is the held shape; a plain word before one is left alone', async () => {
  for (const l of ['chase-verify.in', 'paypal-secure.to', 'portal-rincon.so', 'x-y.no']) {
    const c = cleanTextBoth(`see ${l} now`);
    assert.strictEqual(c.shown, `see ${LINK_TEXT} now`); assert.strictEqual(c.ambiguousLink, false, l);
  }
  for (const l of ['follow-up.It is next', 'up-to-date.In the garage', 'a-b.By the way']) {
    const c = cleanTextBoth(l);
    assert.strictEqual(c.ambiguousLink, true, l); assert.ok(c.shown.includes(LINK_TEXT));
  }
  for (const k of ['leak.in the ceiling', 'evil.in is plain', 'water.to the sink', 'ok.so it works', 'one.at a time']) { assert.strictEqual(cleanText(k), k); assert.strictEqual(cleanTextBoth(k).ambiguousLink, false); }
});

test('R3-3e text whose NFKC reading is a web address (a kept-as-typed ordinal mark standing for a letter) is never shown: the block is held', async () => {
  for (const t of ['evil.c\u00BAm', 'evil.\u00BArg', 'evil.n\u00AAme', 'see evil.c\u00BAm now']) {
    const c = cleanTextBoth(t);
    assert.strictEqual(containsLink(c.shown), false, 'the typed text has no link');
    assert.strictEqual(hasFoldedLink(c.shown), true, t);
    assert.strictEqual(c.ambiguousLink, true, t);
    assert.strictEqual(heldFull(t), true);
  }
  for (const t of ['5\u00B2 ft room', '2\u00BD inch pipe', '1\u00AA y 2\u00BA piso', 'Roundup\u2122 spray', 'evil.com']) assert.strictEqual(hasFoldedLink(cleanTextBoth(t).shown), false, t);
  // the printed (cut) strings are checked the same way: here the whole text has no web address in either reading, and only the hard cut at 300 leaves one
  const whole = `${'a'.repeat(297)}.c\u00BAmx`;
  assert.strictEqual(cleanTextBoth(whole).ambiguousLink, false, 'the whole text is clean in both readings');
  const r = await K.send({ job: baseJob({ name: 'Visit', description: whole }) });
  assert.deepStrictEqual(blockLines(r.email.text), [HEADER, HELD_NOTICE]);
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.cause, 'link_shape');
});

test('R3-3f the cleaner reports a hold request on every reading and never loses it: shape of the result, both fields, idempotence', async () => {
  const c = cleanTextBoth('fine text');
  assert.deepStrictEqual(c, { shown: 'fine text', spaced: 'fine text', symbols: 'fine text', both: 'fine text', ambiguousLink: false });
  assert.deepStrictEqual(cleanTextBoth(null), { shown: '', spaced: '', symbols: '', both: '', ambiguousLink: false });
  // in the title only, and in the description only: the block is held either way
  for (const [name, description] of [['Rincon.Support', 'Fine description.'], ['Fine title', 'Rincon.Support'], ['T', `domestic<b></b> Rincon.Support`]]) {
    const s = await prepareWorkOrderSummary({ name, description });
    assert.strictEqual(s.status, 'held', name); assert.strictEqual(s.meta.cause, 'link_shape'); assert.deepStrictEqual(s.lines, [HEADER, HELD_NOTICE]);
  }
  // the flag is part of the idempotence story: the settled output of a flagged text is link-free and stable
  const once = cleanText('Rincon.Support and Chase.Bank');
  assert.strictEqual(cleanText(once), once); assert.strictEqual(containsLink(once), false);
});

// ════════════════════════════════════════════════════════════════════════
// R3-4  TEXT THAT WILL NOT SETTLE HAS ITS OWN CAUSE (Asimov R3-4, Viper B12, Judge fix 4)
// ════════════════════════════════════════════════════════════════════════
test('R3-4a text that will not settle in the cleaner is held with the cause unsettled_text (medium risk), one constant log line, the fixed held sentence; it is not a scanner error and the alert is still sent', async () => {
  const deep = (n, tail) => `&${'amp;'.repeat(n)}${tail}`;
  const hostile = [`${deep(6, 'lt;b')}x${deep(6, 'gt;')}`, deep(12, ''), `Faucet drips. ${deep(9, 'lt;b')}${K.CANARY}${deep(9, 'gt;')} thanks`, '&amp;'.repeat(1) + 'amp;'.repeat(3000)];
  for (const description of hostile) {
    assert.throws(() => cleanTextBoth(description), (e) => e instanceof cleanMod.CleanError && e.message === 'clean_did_not_settle');
    const r = await K.send({ job: baseJob({ name: 'Visit', description }) });
    assert.deepStrictEqual(blockLines(r.email.text), [HEADER, HELD_NOTICE]);
    const ev = auditEvents(DESC_ACTION)[0];
    assert.strictEqual(ev.details.cause, 'unsettled_text'); assert.strictEqual(ev.details.result, 'held'); assert.strictEqual(ev.risk_level, 'medium');
    assert.strictEqual(r.result.action, 'sent');
    const mine = H.logs.filter((l) => l.includes('did not settle'));
    assert.deepStrictEqual(mine, ['[work-order-summary] The title or description did not settle in the cleaner - block held (unsettled_text).']);
    assert.ok(!K.everythingExceptBody(r.email).includes(K.CANARY));
  }
  // the title too
  const t = await prepareWorkOrderSummary({ name: deep(8, ''), description: 'Fine description here.' });
  assert.strictEqual(t.meta.cause, 'unsettled_text');
  // the time budget is the other "will not settle" cause
  cleanMod._setBudgetMsForTesting(-1);
  try { assert.strictEqual((await prepareWorkOrderSummary({ name: 'x', description: 'y' })).meta.cause, 'unsettled_text'); } finally { cleanMod._setBudgetMsForTesting(); }
  // the held output is byte-identical to every other hold
  const a = await K.send({ job: baseJob({ name: 'Visit', description: hostile[0] }) });
  const b = await K.send({ job: baseJob({ name: 'Visit', description: 'tenant uses a wheelchair' }) });
  assert.strictEqual(a.email.text, b.email.text);
});

test('R3-4b the real scanner failures still report check_error: a throwing screen, a malformed answer, a failed self-test, a non-text value', async () => {
  const causeOf = async (before, job) => { const r = await K.send({ job: job || baseJob({ name: 'Faucet', description: 'drips' }), before }); return { cause: auditEvents(DESC_ACTION)[0].details.cause, r }; };
  for (const [label, impl] of [['throws', () => { throw new Error(K.CANARY); }], ['garbage', () => 'nope'], ['promise', () => Promise.resolve({ status: 'cleared' })], ['bad status', () => ({ status: 'maybe' })]]) {
    try { const { cause, r } = await causeOf(() => K.summaryMod._setScreenForTesting(impl)); assert.strictEqual(cause, 'check_error', label); assert.strictEqual(r.result.action, 'sent'); } finally { K.summaryMod._setScreenForTesting(null); }
  }
  try { const { cause } = await causeOf(() => screenMod._forceSelfTestForTesting(false)); assert.strictEqual(cause, 'check_error', 'failed self-test'); } finally { screenMod._forceSelfTestForTesting(); }
  assert.strictEqual((await causeOf(null, baseJob({ name: 42, description: 'fine' }))).cause, 'check_error', 'non-text value');
  assert.strictEqual((await causeOf(null, baseJob({ name: true, description: {} }))).cause, 'check_error');
});

test('R3-4c ordinary double-escaped text now settles and is shown as the text it was meant to be; the shadow-week SQL counts unsettled_text on its own line, apart from scanner errors', async () => {
  const r = await K.send({ job: baseJob({ name: 'Notes', description: 'Tom &amp;amp; Jerry &amp;lt;3 the faucet &amp;amp;amp; sink' }) });
  assert.ok(blockLines(r.email.text).some((l) => l.includes('Tom & Jerry <3 the faucet & sink')), blockLines(r.email.text).join('|'));
  const spec = readDoc('projects/hub/work-order-notes-alert-SPEC.md');
  assert.ok(/unsettled_text/.test(spec), 'the SPEC names the cause');
  assert.ok(/count\(\*\) filter \(where details->>'cause' = 'unsettled_text'\) as unsettled_text/.test(spec), 'its own line in the counts query');
  assert.ok(/details->>'cause' in \('check_error', 'summary_error'\)\) as scanner_errors/.test(spec), 'scanner errors exclude it');
});

// ════════════════════════════════════════════════════════════════════════
// R3-5  "N DAY NOTICE" IN ITS WRITTEN FORMS (Asimov R3-5, Viper B8, Judge fix 5)
// ════════════════════════════════════════════════════════════════════════
test('R3-5 every written form of "N day notice" holds under legal_eviction (digits and number words to ninety-nine and hundred, glued, qualifiers, "of", "notice of", parentheses, Spanish); entry notices in hours and ordinary notices pass', async () => {
  const numbers = ['1', '3', '7', '14', '30', '45', '60', '90', '99', '100', 'one', 'two', 'three', 'five', 'ten', 'twelve', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
    'twenty one', 'twenty-five', 'sixty three', 'ninety nine', 'hundred', 'one hundred', 'a hundred'];
  let n = 0;
  for (const num of numbers) {
    for (const form of [`${num} day notice`, `${num}-day notice`, `${num} days notice`, `${num} days written notice`, `${num} days of notice`, `${num} business day notice`, `${num} calendar days notice`, `${num} court days notice`,
      `${num} working day notice`, `notice of ${num} days`, `notice (${num} days)`, `notice: ${num} days`, `(${num}) day notice`, `${num} day notice to quit`, `${num} days to vacate`, `${num} days' notice`]) {
      const r = full('', `tenant was handed a ${form} yesterday`);
      assert.strictEqual(r.status, 'held', form); assert.ok(r.categories.includes('legal_eviction'), `${form} -> ${r.categories}`);
      n++;
    }
  }
  for (const f of ['3day notice posted', '30day notice', 'thirty days written notice']) assert.ok(heldFull(f), f);
  for (const f of ['72 hour notice to quit', '24 hours to vacate', '48 hour written notice to pay', '3 hours to cure']) assert.ok(heldFull(f), f);
  const es = ['notificacion de 3 dias', 'notificacion de tres dias', 'notificacion de 30 dias habiles', 'aviso 3 dias', 'aviso 7 dias', 'aviso de tres (3) dias', 'aviso de treinta y cinco dias', 'aviso de quince dias', 'aviso de cien dias',
    'aviso de 3 d\u00EDas', '3 dias de aviso', 'tres dias de aviso', '30 dias de notificacion', '10 dias habiles de aviso', 'avisos de 3 dias', 'notificaciones de 5 dias', 'aviso de siete dias'];
  for (const f of es) { const r = full('', `le llego un ${f}`); assert.strictEqual(r.status, 'held', f); assert.ok(r.categories.includes('legal_eviction'), `${f} -> ${r.categories}`); n++; }
  const pass = ['give 24 hour notice before entry', '48 hours notice please', '72 hours notice for the entry', 'call 3 days before the visit', 'a 5 day lead time for the part', 'notice posted on the door', 'notice the crack in the wall', 'aviso en la puerta',
    'avisar 24 horas antes', 'ready in 5 business days', 'the 3 day weather forecast', '72 hour warranty', 'day shift only', 'we need a notice board', 'sign says notice to all tenants', 'keep a 5 day supply', 'repair takes 3 days'];
  for (const t of pass) assert.strictEqual(heldFull(t), false, `held: ${t}`);
  process.stdout.write(`      (${n} written forms, all held; ${pass.length} ordinary neighbours pass)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// R3-6  THE BOUNDED VOCABULARY ROUND, wo-supp-v3 (Asimov R3-6, Viper B6/B7/B11, Judge fix 5)
// ════════════════════════════════════════════════════════════════════════
// The two fixed natural-sentence sets of the stop rule (Asimov's probes; invented sentences)
const NATURAL_EN = [
  'tenant is pregnant and cannot use the stairs', 'she is expecting a baby in March', 'tenant uses a wheelchair and needs a ramp', 'he is blind and needs braille signage',
  'tenant is elderly and lives alone', 'senior citizen on fixed income', 'she is a widow', 'tenant is deaf', 'he has cancer', 'she has dementia', 'tenant had a stroke',
  'tenant is on oxygen', 'needs a walker', 'uses a cane', 'tenant has a bad heart', 'tenant is in hospice', 'tenant has a mental illness', 'he is bipolar',
  'tenant is gay', 'two men live there', 'same sex couple', 'transgender tenant', 'tenant is a Muslim', 'they are Jewish', 'pastor visiting the tenant', 'tenant goes to church every Sunday',
  'tenant is from Mexico', 'tenant is Mexican', 'tenant is Chinese and does not speak English', 'tenant is undocumented', 'immigration came by', 'tenant is an immigrant',
  'section 8 tenant', 'tenant has a voucher', 'tenant gets welfare', 'tenant receives SSI', 'tenant on disability', 'tenant is a veteran', 'tenant has three children', 'her baby is crying all night',
  'tenant is in jail', 'tenant was arrested', 'the tenant died', 'tenant passed away last week', 'tenant got an eviction notice', 'tenant is behind on rent', 'tenant filed a lawsuit',
  'tenant says her ex-husband is stalking her', 'tenant is afraid of her neighbor', 'the tenant is a single mother', 'tenant is Black', 'the tenant is white', 'tenant is Hispanic', 'tenant is an old lady',
  'she gave birth last week', 'tenant has a bad back', 'tenant has asthma and the mold is bad', 'tenant has allergies', 'tenant takes medication', 'tenant is on dialysis', 'tenant is disabled',
  'tenant has autism', 'tenant has a hearing aid', 'tenant is sober, in recovery', 'tenant is divorced', 'she is a nun', 'he is a priest',
  'tenant is Filipino', 'tenant is Armenian', 'tenant is Russian', 'tenant is Persian', 'tenant speaks Farsi', 'tenant is Korean', 'tenant is Vietnamese',
];
const NATURAL_ES = [
  'la inquilina esta embarazada', 'el inquilino usa silla de ruedas', 'es ciego y necesita ayuda', 'la senora es sorda', 'tiene cancer', 'tiene diabetes', 'tiene demencia',
  'es una persona mayor', 'la inquilina es anciana', 'es discapacitado', 'tiene una discapacidad', 'la inquilina es viuda', 'recibe seccion 8', 'recibe cupones de comida', 'recibe ayuda del gobierno',
  'no tiene papeles', 'es indocumentado', 'vino inmigracion', 'es de Mexico', 'habla solo espanol', 'es musulman', 'es catolica', 'va a la iglesia', 'tiene tres hijos', 'su hijo esta enfermo',
  'su esposo la golpea', 'llamaron a la policia', 'tiene una orden de restriccion', 'el inquilino murio', 'fallecio la semana pasada', 'le llego un aviso de desalojo', 'esta atrasada con la renta',
  'fue arrestado', 'esta en la carcel', 'tiene miedo de su vecino', 'es madre soltera', 'es gay', 'es transgenero', 'esta jubilada', 'es veterano', 'tiene una demanda',
  'tiene un perro de asistencia', 'esta en tratamiento', 'toma medicina', 'tiene asma', 'esta enferma', 'esta hospitalizada', 'tiene artritis', 'usa baston', 'usa andador', 'tiene un bebe',
];
// Viper round 2, B7: direct first- and second-person statements. The last one is an indirect reference (no word of violence, fear or an ex), which is the accepted-residual class.
const DIRECT_STATEMENTS = ['my ex keeps coming back', 'the ex keeps coming back', 'your ex called', 'my husband hit me', 'my boyfriend hits me', 'he beat me',
  'My boyfriend broke the door again, please change the lock and do not give him a key', 'my ex keeps showing up, I need the locks changed'];
const INDIRECT_REFERENCE = 'She stays with her sister now, her husband still has a key';
// Viper round 2, B6: Spanish words the English list holds. Held in a neutral frame, except these seven, which are ordinary Spanish repair or address words on their own and are deliberately NOT held
const B6_WORDS = ['discapacidad', 'anciano', 'anciana', 'viudo', 'viuda', 'divorciado', 'divorciada', 'jubilado', 'jubilada', 'cupones', 'no tiene documentos', 'encinta', 'esperando bebe', 'prenada',
  'denuncia', 'asustada', 'huyendo', 'golpeo', 'le pego', 'mijo', 'mija', 'abuelita', 'no puede caminar', 'notificacion de 3 dias'];
const B6_DELIBERATELY_NOT_HELD = ['pension', 'papeles', 'residencia', 'mica', 'en estado', 'rampa', 'ICE was at the building yesterday'];

test('R3-6a the stop rule: Spanish natural-sentence coverage is within ten points of English on the fixed sets; both are above 90 percent', async () => {
  assert.strictEqual(NATURAL_EN.length, 74); assert.strictEqual(NATURAL_ES.length, 51);
  const pct = (list) => 100 * list.filter((t) => heldFull(t)).length / list.length;
  const en = pct(NATURAL_EN); const es = pct(NATURAL_ES);
  assert.ok(es >= en - 10, `Spanish ${es.toFixed(1)} vs English ${en.toFixed(1)}`);
  assert.ok(en >= 90 && es >= 90, `English ${en.toFixed(1)}, Spanish ${es.toFixed(1)}`);
  process.stdout.write(`      (English ${en.toFixed(0)}% of 74, Spanish ${es.toFixed(0)}% of 51; before this round 91% and 76%)\n`);
});

test('R3-6b Viper\'s round-2 lists: every direct statement (B7) and every Spanish word that is not an ordinary repair word (B6) is held; the named exceptions are not', async () => {
  for (const t of DIRECT_STATEMENTS) assert.ok(heldFull(t), `direct statement shown: ${t}`);
  for (const w of B6_WORDS) assert.ok(heldFull(`please note ${w} for this unit`), `Spanish word shown: ${w}`);
  // the indirect reference and the ordinary Spanish words are the accepted residual / deliberate non-holds, and they are named here so nobody mistakes them for an oversight
  assert.strictEqual(heldFull(INDIRECT_REFERENCE), false, 'indirect reference: accepted residual class (euphemism)');
  for (const w of B6_DELIBERATELY_NOT_HELD) assert.strictEqual(heldFull(`please note ${w} for this unit`), false, `now held: ${w}`);
});

test('R3-6c first-, second- and third-person violence, stalking and fear wording, English and Spanish: every form holds, and the ordinary words next to them pass', async () => {
  const hold = ['he hit me', 'she hits me', 'he hit him', 'hits him', 'he beat him', 'beats him', 'beats me', 'beat me up', 'hurt me', 'hurts him', 'punched me', 'slapped him', 'kicked her', 'shoved me', 'pushed him', 'choked her',
    'strangled', 'follows me', 'followed me', 'being followed', 'kill me', 'kill himself', 'my ex', 'your ex', 'the ex still has a key', 'ex keeps calling', 'do not give her', 'never give him', 'dont allow him', 'keep her out',
    'has a gun', 'pointed a gun', 'fled', 'fleeing',
    'me pega', 'me pego', 'le pegaba', 'me golpeo', 'la golpeaba', 'me acosa', 'acosaba', 'agrede', 'me agredio', 'asustado', 'asustada', 'huyendo', 'huyo', 'escondiendose de el', 'me va a matar', 'la quiere matar', 'matarme',
    'me persigue', 'no lo dejen entrar', 'no le den la llave', 'me siento insegura', 'no se siente seguro', 'tu ex'];
  for (const t of hold) { const r = full('', `tenant note: ${t}`); assert.strictEqual(r.status, 'held', t); }
  const pass = ['the ball hit the window', 'kick plate on the door', 'follow up with the plumber', 'following the inspection', 'push plate on the gate', 'kill the water to the unit', 'kill switch on the disposal', 'spray to kill them',
    'the ex-tenant left a mattress', 'ex tenant forwarding address', 'extension cord', 'flood sensor', 'caulk gun', 'heat gun', 'nail gun', 'pulled the plug', 'golpe en la pared', 'golpeteo en la tuberia', 'la puerta no cierra', 'asistencia tecnica'];
  for (const t of pass) assert.strictEqual(heldFull(t), false, `held: ${t}`);
});

test('R3-6d Spanish for the classes the English list already holds: disability and equipment, old age, widowhood and marital status, retirement, benefits, immigration papers, pregnancy and birth, police reports, fear, children and grandparents, assistance animals, "from" plus a country', async () => {
  const classes = {
    'disability and equipment': ['discapacidad', 'discapacidades', 'minusvalia', 'paralisis', 'artritis', 'artrosis', 'audifonos', 'protesis', 'no puede caminar', 'dificultad para caminar', 'en tratamiento'],
    'old age': ['anciano', 'ancianos', 'ancianita', 'tercera edad', 'persona mayor', 'personas mayores', 'adulto mayor', 'adultos mayores', 'viejito', 'viejita'],
    'widowhood and marital status': ['viudo', 'viuda', 'viudos', 'viudas', 'divorciado', 'divorciada', 'divorcio', 'madre soltera', 'padre soltero'],
    'retirement and pensions': ['jubilado', 'jubilada', 'jubilacion', 'pensionado', 'pensionada', 'recibe pension', 'su pension', 'pension alimenticia'],
    'public benefits and food programs': ['cupones', 'recibe cupones', 'ayuda del gobierno', 'ayuda publica', 'beneficios del gobierno', 'cupones de alimentos', 'ayuda con la renta', 'asistencia de renta', 'asistencia para vivienda'],
    'immigration papers and residence': ['residencia permanente', 'residente permanente', 'tarjeta de residente', 'permiso de residencia', 'papeles migratorios', 'arreglando papeles', 'no tiene documentos', 'estatus migratorio', 'consulado'],
    'pregnancy and birth': ['encinta', 'prenada', 'dio a luz', 'dar a luz', 'dieron a luz', 'embarazada'],
    'police reports and complaints': ['denuncia', 'denuncias', 'denunciar', 'denuncio', 'reporte policial'],
    'fear and fleeing': ['asustada', 'asustado', 'huyendo', 'huyeron', 'miedo', 'tengo miedo', 'me siento insegura'],
    'hitting': ['golpeo', 'golpeado', 'le pego', 'me pega', 'le pegaba'],
    'children and grandparents': ['mijo', 'mija', 'mijito', 'abuelita', 'abuelito', 'abuela', 'abuelo', 'nena', 'nene', 'chiquillos', 'bebito', 'chamaquito'],
    'assistance animals': ['perro de asistencia', 'perros de asistencia', 'perro lazarillo', 'perro de terapia', 'animal de soporte emocional', 'mascota de asistencia'],
  };
  let n = 0;
  for (const [cls, words] of Object.entries(classes)) for (const w of words) { assert.ok(heldFull(`please note ${w} for this unit`), `${cls}: ${w}`); n++; }
  for (const t of ['es de Mexico', 'son de Guatemala', 'vino de El Salvador', 'nacida en Peru', 'originaria de Colombia', 'llegaron de Honduras hace un ano', 'es natural de Armenia']) {
    const r = full('', t); assert.strictEqual(r.status, 'held', t); assert.ok(r.categories.includes('national_origin_immigration'), `${t} -> ${r.categories}`); n++;
  }
  // ordinary Spanish repair and address words are not held
  for (const t of ['la mayor parte del techo', 'multa por ruido', 'corte de agua en el edificio', 'el menor ruido', 'rampa del garaje', 'mica de la lampara', 'residencia de la calle cinco', 'papeles del contrato', 'planta de tratamiento de agua',
    'la china de la cocina esta rota', 'es de chile el color', 'avenida de Mexico numero 5', 'la tuberia es de cobre', 'el techo es de lamina', 'la puerta es de madera', 'esta de acuerdo con el presupuesto']) assert.strictEqual(heldFull(t), false, `held: ${t}`);
  process.stdout.write(`      (${n} Spanish words and sentences in 13 classes, all held)\n`);
});

test('R3-6e plural forms of the single-word slurs hold (-s and -es), and so do possessives; built from the terms file at run time, none written here', async () => {
  const singles = T.SLURS.filter((s) => /^[a-z]+$/.test(s) && !s.endsWith('s') && s.length >= 3);
  assert.ok(singles.length >= 50, `${singles.length} single-word slurs`);
  let n = 0;
  for (const s of singles) {
    for (const form of [`${s}s`, `${s}es`, `${s}'s`, `the ${s}s next door`, `${s.toUpperCase()}S`, `${s}S`]) {
      assert.ok(heldFull(`please note ${form} for this unit`), `plural or possessive not held (${s.length} letters): form ${form.length - s.length}`);
      n++;
    }
  }
  // the obfuscation tolerance still applies to the plural (repeated letters, symbol swaps)
  const o = singles.find((s) => s.length >= 6 && /o/.test(s));
  assert.ok(heldFull(`please note ${o.replace(/o/g, '0')}s for this unit`));
  // ordinary words that end in s, es or 's are not touched
  for (const t of ['the pipes and fixtures', 'glasses on the counter', 'boxes in the garage', 'the dog\'s bowl', 'tenants\' meeting', 'access to the gates', 'chimes and lights', 'tubes and hoses', 'kites and flags']) assert.strictEqual(heldFull(t), false, `held: ${t}`);
  process.stdout.write(`      (${singles.length} single-word entries x 6 forms = ${n} variants, all held)\n`);
});

test('R3-6f the remaining unambiguous pictographs of kinds already on the list are held; the ordinary look-alikes (siren, skull, rainbow, safety vest) are NOT added', async () => {
  const added = { disability_health: [0x2695, 0x1F9AE], sex_gender: [0x1FAC4, 0x1FAC3], age: [0x1F474, 0x1F475, 0x1F9D3], religion: [0x1F54B, 0x1F6D5, 0x26E9, 0x1FAAF] };
  for (const [cat, list] of Object.entries(added)) {
    for (const c of list) {
      const r = full('', `tenant ${cp(c)} note`);
      assert.strictEqual(r.status, 'held', `U+${c.toString(16)}`); assert.ok(r.categories.includes(cat), `U+${c.toString(16)} -> ${r.categories}`);
      assert.ok(T.SYMBOLS.some((g) => g.cat === cat && (g.cps || []).includes(c)), 'it is on the list, not held by accident');
    }
  }
  for (const c of [0x1F6A8, 0x1F480, 0x1F308, 0x1F9BA, 0x2620]) assert.strictEqual(heldFull(`fixed the leak ${cp(c)} thanks`), false, `U+${c.toString(16)} must stay ordinary`);
  assert.ok(T.SYMBOLS.reduce((a, s) => a + (s.cps || []).length + (s.ranges || []).length, 0) <= 80, 'the list stays short');
});

test('R3-6g every added v3 term and pair rule is real: it holds in a sentence, it is whole-word, and it is not already covered by an older term', async () => {
  let n = 0;
  for (const [cat, entries] of Object.entries(T.TERMS_V3_ADDITIONS)) {
    assert.ok(screenMod.CATEGORY_VOCABULARY.includes(cat), cat);
    for (const { term } of entries) {
      assert.ok(heldFull(`please note ${term.replace(/\*/g, 'x')} for this unit`), `added term does not hold: ${term}`);
      n++;
    }
  }
  assert.ok(n >= 300, `${n} v3 terms`);
  const rule = T.PAIR_RULES_V3_ADDITIONS[0];
  assert.strictEqual(rule.name, 'de-pais-es');
  for (const c of ['chile', 'china', 'cuba', 'jordan']) assert.ok(!rule.b.includes(c), `${c} is also an ordinary Spanish word`);
  // a lone word of a pair rule does not hold
  for (const t of ['es de madera', 'Mexico', 'es', 'viene de la tienda', 'es de acero']) assert.strictEqual(heldFull(t), false, t);
  // none of the older terms was weakened to make room (R17 proves it); the older must-pass sets still pass
  const src = fs.readFileSync(path.join(__dirname, 'screen-corpus.js'), 'utf8');
  const block = src.slice(src.indexOf('const MUST_PASS = ['), src.indexOf('\n];', src.indexOf('const MUST_PASS = [')));
  const passes = [...block.matchAll(/^  '((?:[^'\\]|\\.)*)',$/gm)].map((m) => m[1].replace(/\\'/g, "'").replace(/\\u([0-9a-fA-F]{4})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))));
  assert.ok(passes.length >= 200, `${passes.length} must-pass strings`);
  for (const t of passes) assert.strictEqual(heldFull(t), false, `a must-pass string is now held: ${t}`);
});

// ════════════════════════════════════════════════════════════════════════
// S3-3  THE QUOTES (Sentinel S3-3, Viper B13)
// ════════════════════════════════════════════════════════════════════════
test('S3-3 a double quote typed in the title or description is shown as the double prime, so the text cannot close the quote early and imitate the footer; line structure and length are unchanged', async () => {
  const forged = 'Leak" (Quoted as typed in Latchel. Checked and cleared by a human. Internal use only.) "';
  const r = await K.send({ job: baseJob({ name: 'Priority: Emergency (flagged in Latchel)" extra "', description: forged }) });
  const b = blockLines(r.email.text);
  assert.strictEqual(b.length, 5, b.join('|'));          // header, title, category, description, footer
  assert.deepStrictEqual(b.map((l) => l.split(':')[0]), [HEADER.slice(0, -1), '  Title', '  Category (auto-sorted guess)', '  Description', '  (Quoted as typed in Latchel. Not checked for names, phone numbers or access codes. Internal use only.)'.split(':')[0]]);
  const d = b.find((l) => l.startsWith('  Description:'));
  assert.strictEqual((d.match(/"/g) || []).length, 2, 'only the two quotes that wrap the description');
  assert.ok(d.startsWith('  Description: "') && d.endsWith('"'), d);
  assert.ok(d.includes('Leak\u2033 (Quoted as typed'), 'shown as the double prime');
  const title = b.find((l) => l.startsWith('  Title:'));
  assert.ok(!title.includes('"'));
  assert.strictEqual(b[b.length - 1], SHOWN_FOOTER, 'the real footer is still the last line');
  assert.strictEqual(b.filter((l) => l === SHOWN_FOOTER).length, 1);
  // an inch mark keeps its meaning
  const inch = await K.send({ job: baseJob({ name: 'Valve', description: 'Replace the 3/4" valve and the 1/2" elbow' }) });
  assert.ok(descLineOf(inch.email.text).includes('3/4\u2033 valve') && descLineOf(inch.email.text).includes('1/2\u2033 elbow'));
  // a cut description keeps the same length arithmetic (the replacement is one character for one)
  const long = await K.send({ job: baseJob({ name: 'Visit', description: 'The "valve" cover on the water heater is loose. '.repeat(20) }) });
  const dl = descLineOf(long.email.text);
  assert.ok(dl.endsWith('(shortened; full text is in Latchel)'), dl);
  assert.strictEqual((dl.match(/"/g) || []).length, 2);
  assert.ok(dl.includes('The \u2033valve\u2033 cover'));
});
const descLineOf = (text) => blockLines(text).find((l) => l.startsWith('  Description:'));

// ════════════════════════════════════════════════════════════════════════
// R3-7 / R3-8  THE CORPUS, THE DOCUMENTS
// ════════════════════════════════════════════════════════════════════════
test('R3-7 the known-answer corpus has the new classes: at least 150 new must-hold strings (every v3 category family) and the ordinary neighbours as must-pass; the look-alike lettering range is a named must-hold', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'screen-corpus.js'), 'utf8');
  const marker = '// ── round 3 (wo-supp-v3)';
  const holdBlock = src.slice(src.indexOf(marker), src.indexOf('\n];', src.indexOf(marker)));
  const holds = [...holdBlock.matchAll(/^  \['((?:[^'\\]|\\.)*)', '([a-z_]+)'\],$/gm)];
  assert.ok(holds.length >= 150, `${holds.length} new must-hold strings`);
  const cats = new Set(holds.map((m) => m[2]));
  for (const c of ['safety_violence', 'minors', 'familial_status', 'health', 'disability_health', 'marital_status', 'age', 'benefits_income', 'immigration_language', 'national_origin_immigration', 'legal_eviction', 'religion_identity', 'source_of_income', 'sex_gender', 'religion']) assert.ok(cats.has(c), `no new must-hold for ${c}`);
  const passMarker = '// ── round 3: ordinary neighbours';
  const passBlock = src.slice(src.indexOf(passMarker), src.indexOf('\n];', src.indexOf(passMarker)));
  assert.ok([...passBlock.matchAll(/^  '/gm)].length >= 40, 'new must-pass neighbours');
  assert.ok(src.includes('1F170') && src.includes('1F150'), 'the look-alike lettering range is a named must-hold');
  assert.ok(heldFull(`tenant ${cp(0x1F170)} note`) && heldFull(`tenant ${cp(0x1F150)} note`));
});

test('R3-8 the documents say what the code does: the SPEC names the third fix round, wo-supp-v3, the new cause, 733 characters and 213 v2 terms; no document carries the stale length or term count', async () => {
  const spec = readDoc('projects/hub/work-order-notes-alert-SPEC.md');
  assert.ok(/third fix round/i.test(spec.split('\n').slice(0, 4).join('\n')), 'the status line names the third fix round');
  assert.ok(spec.includes('wo-supp-v3') && spec.includes('unsettled_text') && spec.includes('733 characters over 6 lines'));
  assert.ok(spec.includes('(version `wo-supp-v4`: v1, plus the 213 v2 terms'), 'the SPEC describes the current list as wo-supp-v4 and its v2 history (the fourth fix round renamed it)');
  const inv = readDoc('compliance/work-order-note-alerts-data-inventory.md');
  assert.ok(inv.includes('wo-supp-v3') || /third fix round/i.test(inv), 'the data inventory addendum is current');
  for (const rel of ['projects/hub/work-order-notes-alert-SPEC.md', 'compliance/work-order-note-alerts-data-inventory.md', 'compliance/work-order-note-alerts-description-decision-resolution.md', 'compliance/work-order-note-alerts-description-governance-review.md']) {
    const text = readDoc(rel);
    assert.ok(!/710 to 730|about 710|697 characters|203 (added|terms)|203 new/.test(text), `${rel} carries a stale number`);
  }
  // the summary file's own comment: the worst case and the typical length
  const sum = fs.readFileSync(APPROVAL('lib/work-order-summary.js'), 'utf8');
  assert.ok(sum.includes('733 characters over 6 lines') && sum.includes('about 330'));
});

runner.run();
