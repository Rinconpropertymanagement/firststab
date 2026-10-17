#!/usr/bin/env node
/**
 * test/round4-tests.js
 *
 * Tests for the fourth fix round (after the third round's tester, security,
 * red-team, governance and judge findings on commit 2ab3d53). One test group
 * per condition, named after the condition it proves:
 *
 *   R4-1  a symbol that NFKC turns into letters (trademark, service mark, numero, care-of, ordinal marks,
 *         squared unit signs ...) standing where a space belongs is a space; digit-like marks keep reading as digits
 *   R4-2  the e-mail exemption in front of an at-sign needs a real host after it
 *   R4-3  the host ends at the first character after its ending that is not an ASCII letter or digit
 *   R4-4  the v3 list is pinned by a snapshot; every v3 and v4 term holds in a natural sentence
 *   R4-5  TARS's surviving mutants: the hour-notice pattern, and only the 2-label letters/digits-first shape holds the block
 *   R4-6  violence done to a named person (the 38-item list), English and Spanish, and its ordinary neighbours
 *   R4-7  first-person Spanish forms ("soy de Mexico", "no tengo papeles")
 *   R4-8  Section 8 under the program's own names, and the section sign
 *   R4-9  a cleaner-requested hold has its own cause (link_shape)
 *   R4-10 the nesting wording matches the six passes the code allows
 *   R4-11 the documents say what the code does
 *
 * No bypass string and no slur is written out beyond plain test inputs: the sweeps are built
 * from the live phrase lists and from the Unicode tables at run time.
 *
 * Run alone:  node projects/hub/approval-briefing/test/round4-tests.js
 * The exhaustive version of the symbol sweep is test/sweep-full.js (a few minutes, not part of run-all).
 */

const K = require('./test-kit');
const { H, assert, path, baseJob, auditEvents, blockLines, DESC_ACTION, HEADER, HELD_NOTICE } = K;
const fs = require('fs');
const cleanMod = H.load('lib/work-order-text-clean.js');
const screenMod = H.load('lib/work-order-text-screen.js');
const T = H.load('lib/work-order-text-screen-terms.js');
const { prepareWorkOrderSummary } = K.summaryMod;
const { cleanText, cleanTextBoth, symbolsToSpaces, LINK_TEXT } = cleanMod;
const { screenWorkOrderText } = screenMod;
const sharedTerms = require(path.resolve(H.HUB_DIR, 'maintenance-history/lib/protected-class-terms.js'));
const V3 = require('./fixtures/wo-supp-v3-terms.json');
const V4 = require('./fixtures/wo-supp-v4-terms.json');
const REPO = path.resolve(H.HUB_DIR, '../..');

const runner = K.makeRunner('Work Order Alert - fourth fix round');
const { test } = runner;
const cp = (...codes) => String.fromCodePoint(...codes);

const full = (title, description) => K.screenFull(title, description);
const heldFull = (desc, title = '') => full(title, desc).status === 'held';
const readDoc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const ctx = (s) => `please check the kitchen sink in the unit, ${s}, thanks`;
const heldOrHidden = (text) => heldFull(text) || cleanTextBoth(text).shown.includes(LINK_TEXT);
const clean1 = (t) => cleanTextBoth(t).shown;

// The rule for "a circled, parenthesised or squared single letter", written out independently of the cleaner:
// NFKC gives exactly one letter, with or without brackets, a stop or a space.
function isSpelledLetter(ch) {
  const n = ch.normalize('NFKC');
  if (n === ch || !/\p{L}/u.test(n)) return false;
  const rest = Array.from(n.replace(/[().\s]/g, ''));
  return rest.length === 1 && /^\p{L}$/u.test(rest[0]);
}

/** Every assigned punctuation, symbol and space code point of every plane (as characters), split into separators and spelled letters. */
function separatorCodePoints() {
  const separators = [];
  const letters = [];
  for (let c = 0; c <= 0x10FFFF; c++) {
    if (c >= 0xD800 && c <= 0xDFFF) continue;
    const ch = cp(c);
    if (!/^[\p{P}\p{S}\p{Z}]$/u.test(ch)) continue;
    (isSpelledLetter(ch) ? letters : separators).push(ch);
  }
  return { separators, letters };
}
let swept = null;
const sweepSet = () => swept || (swept = separatorCodePoints());

function sharedMultiWord() {
  const out = [];
  for (const list of Object.values(sharedTerms.CATEGORIES)) for (const term of list) { const t = term.trim(); if (t.includes(' ')) out.push(t); }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// R4-1  SYMBOLS THAT NFKC TURNS INTO LETTERS (Asimov R4-1, TARS R3-2 fail, Judge fix 1)
// ════════════════════════════════════════════════════════════════════════
const NAMED_MARKS = {
  'trademark sign': 0x2122, 'service mark sign': 0x2120, 'numero sign': 0x2116, 'care-of sign': 0x2105, 'account-of sign': 0x2100,
  'degree Celsius sign': 0x2103, 'degree Fahrenheit sign': 0x2109, 'telephone sign': 0x2121, 'facsimile sign': 0x213B,
  'feminine ordinal indicator': 0xAA, 'masculine ordinal indicator': 0xBA, 'micro sign': 0xB5, 'superscript n': 0x207F,
  'square metre squared sign': 0x33A1, 'square kilogram sign': 0x338F, 'square megahertz sign': 0x3392, 'square percent sign': 0x33AA, 'square corporation sign': 0x337F,
  'katakana square sign': 0x3300, 'square era name sign': 0x337B, 'squared DJ': 0x1F190, 'arabic ligature rial sign': 0xFDFC,
};
const PHRASES5 = ['food stamps', 'restraining order', 'section 8', 'hearing aid', 'hits me'];

test('R4-1a symbolsToSpaces: the symbols that fold to letters become spaces; digit-like marks, circled/parenthesised/squared letters, Roman numerals and ordinary text are not touched', async () => {
  for (const [name, c] of Object.entries(NAMED_MARKS)) {
    assert.ok(/\p{L}/u.test(cp(c).normalize('NFKC')), `${name} does not fold to letters, so it is not a test of this rule`);
    assert.strictEqual(symbolsToSpaces(`a${cp(c)}b`), 'a b', `${name} (U+${c.toString(16)}) is not a space`);
  }
  // not touched: numbers (they keep reading as digits), letters in a circle or brackets (they ARE letters), Roman numerals, plain text
  const untouched = ['5² ft', '2½ inch', '¼ turn', '① ②', '⑴ ⒈', '⁰⁴₀₉', 'Ⓐⓐ', '⒜', '\u{1F130}\u{1F170}', '㋐', 'Ⅷ', 'plain text, 3/4" pipe & fitting', 'café señor', 'こんにちは', 'x°y', '§ 8'];
  for (const t of untouched) assert.strictEqual(symbolsToSpaces(t), t, `touched: ${JSON.stringify(t)}`);
  assert.strictEqual(symbolsToSpaces('plain'), 'plain');
  // the spelled letters are exactly the characters the independent rule says (circled, parenthesised, squared letters of any script)
  const { separators, letters } = sweepSet();
  assert.ok(separators.length > 8000 && letters.length > 300, `${separators.length} separators, ${letters.length} spelled letters`);
  for (const ch of letters) assert.strictEqual(symbolsToSpaces(ch), ch, `a spelled letter was turned into a space: U+${ch.codePointAt(0).toString(16)}`);
  for (const ch of ['Ⓐ', '⒜', '\u{1F130}', '\u{1F110}']) assert.ok(letters.includes(ch), 'circled, parenthesised and squared letters are the excluded class');
  // every separator that folds to letters is turned into a space by symbolsToSpaces; the others are left for the ordinary folding
  let folding = 0;
  for (const ch of separators) {
    const n = ch.normalize('NFKC');
    if (n !== ch && /\p{L}/u.test(n)) { folding++; assert.strictEqual(symbolsToSpaces(ch), ' ', `U+${ch.codePointAt(0).toString(16)} is not a space`); }
  }
  assert.ok(folding > 250, `${folding} symbols fold to letters`);
  process.stdout.write(`      (${separators.length} punctuation, symbol and space code points; ${folding} of them fold to letters and are read as spaces; ${letters.length} circled, parenthesised and squared letters are letters and are left alone)\n`);
});

test('R4-1b EVERY punctuation, symbol and space code point of every plane (BMP and astral), as the separator in five protected phrases (shared, Section 8 and feature-local), through the real path: 0 slips', async () => {
  const { separators, letters } = sweepSet();
  let n = 0;
  const slips = [];
  for (const ch of separators) {
    for (const phrase of PHRASES5) {
      n++;
      if (!heldOrHidden(ctx(phrase.replace(/ /g, ch)))) slips.push(`U+${ch.codePointAt(0).toString(16)}`);
    }
  }
  assert.ok(n > 40000, `${n} variants`);
  assert.deepStrictEqual(slips, [], `${slips.length} of ${n} variants slipped through`);
  process.stdout.write(`      (${separators.length} code points x ${PHRASES5.length} phrases = ${n} variants, 0 slipped through; ${letters.length} circled, parenthesised and squared letters excluded because they are letters; the exhaustive sweep of every shared phrase is test/sweep-full.js)\n`);
});

test('R4-1c EVERY multi-word phrase of the shared list with every ASCII mark, every symbol that folds to letters and a spread of all other classes in place of the space is held', async () => {
  const phrases = sharedMultiWord();
  phrases.push('section 8');
  assert.ok(phrases.length >= 60);
  const { separators } = sweepSet();
  const ascii = separators.filter((c) => c.charCodeAt(0) < 128);
  const folding = separators.filter((c) => { const nf = c.normalize('NFKC'); return nf !== c && /\p{L}/u.test(nf); });
  // every 37th of the rest: all categories of punctuation, symbols and spaces, spread over the planes
  const spread = separators.filter((c, i) => i % 37 === 0);
  const named = Object.values(NAMED_MARKS).map((c) => cp(c));
  const set = [...new Set([...ascii, ...folding, ...spread, ...named])];
  assert.ok(ascii.length >= 30 && folding.length >= 250 && set.length > 400, `${ascii.length} ASCII, ${folding.length} folding, ${set.length} in all`);
  let n = 0;
  const slips = [];
  for (const phrase of phrases) {
    assert.ok(heldFull(ctx(phrase)), `plain phrase not held: ${phrase}`);
    for (const sep of set) {
      if (phrase.includes(sep)) continue;
      n++;
      if (!heldOrHidden(ctx(phrase.replace(/ /g, sep)))) slips.push(`${phrase} / U+${sep.codePointAt(0).toString(16)}`);
    }
  }
  assert.deepStrictEqual(slips, [], `${slips.length} of ${n} slipped through`);
  process.stdout.write(`      (${phrases.length} shared phrases x ${set.length} separators = ${n} variants, 0 slipped through)\n`);
});

test('R4-1d the named marks (trademark, service mark, numero, care-of, ordinal marks ...) between the words of five protected phrases: held end to end through the summary, in the description, in the title and split across both', async () => {
  const names = Object.keys(NAMED_MARKS);
  let n = 0;
  for (const name of names) {
    const mark = cp(NAMED_MARKS[name]);
    for (const phrase of PHRASES5) {
      const typed = phrase.replace(/ /g, mark);
      for (const [title, description] of [['Visit', `check the sink ${typed} thanks`], [`${typed} visit`, 'check the sink'], ['Visit', typed]]) {
        const s = await prepareWorkOrderSummary({ name: title, description });
        assert.strictEqual(s.status, 'held', `${name} in "${phrase}" was shown`);
        assert.deepStrictEqual(s.lines, [HEADER, HELD_NOTICE]);
        n++;
      }
    }
  }
  // the same marks inside the real alert: the email carries only the held sentence, no category name is stored
  const r = await K.send({ job: baseJob({ name: 'Visit', description: `tenant gets food${cp(0x2122)}stamps and restraining${cp(0x2116)}order` }) });
  assert.deepStrictEqual(blockLines(r.email.text), [HEADER, HELD_NOTICE]);
  assert.strictEqual(auditEvents(DESC_ACTION)[0].details.cause, 'local_screen');
  process.stdout.write(`      (${names.length} marks x ${PHRASES5.length} phrases x 3 placements = ${n} end-to-end checks)\n`);
});

test('R4-1e ordinary text with those marks is not held and is shown exactly as the cleaner has always shown it (brand names, unit numbers, areas, temperatures, fractions, ordinal marks)', async () => {
  const ordinary = ['Brand\u2122 faucet leaking', 'Roundup\u2120 spray on the lawn', 'Unit N\u00BA 5 garbage disposal', 'Unit No. 5 garbage disposal', 'Apt 2\u00AA planta, 1\u00BA piso, bano roto', 'Kwikset\u00AE lock', '25 \u33A1 living room needs paint',
    '5\u2103 outside, heater needed', 'replace the 2\u00BD inch valve', 'room is 5\u00B2 ft', '3/4\u2033 shutoff valve', 'copyright \u00A9 notice sign', 'Price \u20AC45 + tax', 'a\u2194b arrow label on the panel', 'caf\u00E9 se\u00F1or ba\u00F1o'];
  for (const t of ordinary) {
    const s = await prepareWorkOrderSummary({ name: 'Repair', description: t });
    assert.strictEqual(s.status, 'shown', `held: ${JSON.stringify(t)}`);
    assert.strictEqual(s.lines.find((l) => l.startsWith('  Description:')), `  Description: "${cleanText(t)}"`);
  }
  // the marks the cleaner keeps as typed are still in the display
  for (const [t, kept] of [['Brand\u2122 faucet leaking', '\u2122'], ['Unit N\u00BA 5 garbage disposal', '\u00BA'], ['replace the 2\u00BD inch valve', '\u00BD'], ['room is 5\u00B2 ft', '\u00B2'], ['Roundup\u2120 spray on the lawn', '\u2120']]) assert.ok(cleanText(t).includes(kept), t);
});

test('R4-1f digit-like marks keep reading as digits: superscript, fraction and circled digits still make a notice or a Social Security number, and the symbols reading leaves them alone', async () => {
  const cases = [['³ day notice', 'legal_eviction'], ['③ day notice posted', 'legal_eviction'], ['3¹ day notice', 'legal_eviction'], ['¹²³-⁴⁵-⁶⁷⁸⁹', 'financial_id'], ['①②③-④⑤-⑥⑦⑧⑨', 'financial_id'], ['SSN ₁₂₃ ₄₅ ₆₇₈₉', 'financial_id']];
  for (const [t, cat] of cases) {
    const r = full('', t);
    assert.strictEqual(r.status, 'held', t);
    assert.ok(r.categories.includes(cat), `${JSON.stringify(t)} -> ${r.categories}`);
  }
  for (const t of ['5² ft', '2½ inch', '① ② ③', '³ phase panel']) {
    const c = cleanTextBoth(t);
    assert.strictEqual(c.symbols, c.shown, `the symbols reading changed a digit-like mark: ${t}`);
  }
  // and the ordinary neighbours of those patterns still pass
  for (const t of ['³ phase panel', '5² ft room', 'call 3 hours before', 'room 3² and 4²']) assert.strictEqual(heldFull(t), false, t);
});

test('R4-1g the cleaner hands over four readings; the symbols reading is computed only when there is a symbol; the displayed text never changes; either reading failing to settle fails them all', async () => {
  const plain = cleanTextBoth('fine text');
  assert.deepStrictEqual(plain, { shown: 'fine text', spaced: 'fine text', symbols: 'fine text', both: 'fine text', ambiguousLink: false });
  const sym = cleanTextBoth(`food${cp(0x2116)}stamps`);
  assert.strictEqual(sym.shown, 'foodNostamps'); assert.strictEqual(sym.symbols, 'food stamps'); assert.strictEqual(sym.spaced, sym.shown); assert.strictEqual(sym.both, sym.symbols);
  const inv = cleanTextBoth(`food${cp(0x2116)}stamps${cp(0x200B)}`);
  assert.strictEqual(inv.both, 'food stamps'); assert.strictEqual(inv.symbols, 'food stamps'); assert.strictEqual(inv.shown, 'foodNostamps');
  const mixed = cleanTextBoth(`protection${cp(0x200B)}from${cp(0x2116)}abuse`);
  assert.strictEqual(mixed.shown, 'protectionfromNoabuse'); assert.strictEqual(mixed.spaced, 'protection fromNoabuse'); assert.strictEqual(mixed.symbols, 'protectionfrom abuse'); assert.strictEqual(mixed.both, 'protection from abuse');
  // a three-word phrase that needs the zero-width space as one separator AND a symbol as the other is held, and only the fourth reading shows it
  const proofs = [];
  for (const three of sharedMultiWord().filter((p) => p.split(' ').length === 3)) {
    const [a, b, c] = three.split(' ');
    const text = `${a}${cp(0x200B)}${b}${cp(0x2116)}${c}`;
    const parts = cleanTextBoth(text);
    const withoutBoth = screenWorkOrderText({ title: '', description: parts.shown, spaced: { title: '', description: parts.spaced }, symbols: { title: '', description: parts.symbols } });
    if (withoutBoth.status === 'cleared') proofs.push([three, heldFull(text)]);
  }
  assert.ok(proofs.length >= 3, `${proofs.length} three-word phrases need the fourth reading`);
  for (const [three, held] of proofs) assert.strictEqual(held, true, `the fourth reading does not hold "${three}"`);
  // and the summary really hands the fourth reading to the screen (end to end, not only through the test kit)
  for (const [three] of proofs) {
    const [a, b, c] = three.split(' ');
    const s = await prepareWorkOrderSummary({ name: 'Visit', description: `${a}${cp(0x200B)}${b}${cp(0x2116)}${c}` });
    assert.strictEqual(s.status, 'held', `the summary shows "${three}" typed with a zero-width space and a numero sign`);
  }
  // a malformed extra reading is a scanner error (fail closed), never quietly ignored; null and undefined mean "no such reading"
  for (const key of ['spaced', 'symbols', 'both']) {
    for (const bad of [42, 'text', { title: 'a' }, { title: 1, description: 'x' }, [], true]) {
      const r = screenWorkOrderText({ title: 'a', description: 'b', [key]: bad });
      assert.strictEqual(r.status, 'held', `${key}: ${JSON.stringify(bad)}`); assert.strictEqual(r.cause, 'check_error');
    }
    for (const ok of [null, undefined]) assert.strictEqual(screenWorkOrderText({ title: 'a', description: 'b', [key]: ok }).status, 'cleared');
  }
  // the symbols readings cannot ask for a hold of their own (only the displayed text and the spaced reading can): a symbol only ever ADDS a space there
  assert.strictEqual(cleanTextBoth(`see x${cp(0x2116)}Rincon.Info`).ambiguousLink, true, 'the displayed text has the shape');
  assert.strictEqual(cleanTextBoth(`Rincon${cp(0x2122)}.Info`).ambiguousLink, true, 'a kept mark that folds to letters makes the displayed text a link in its folded reading (the existing rule)');
  assert.strictEqual(cleanTextBoth(`fine${cp(0x2116)} text. Info follows`).ambiguousLink, false);
  // idempotence and no link or invisible character in any reading
  for (const t of [`food${cp(0x2116)}stamps`, `a${cp(0x2122)}evil.com`, `x${cp(0x2105)}<b>y</b>${cp(0x200B)}z`]) {
    const c = cleanTextBoth(t);
    for (const r of [c.shown, c.spaced, c.symbols, c.both]) { assert.strictEqual(cleanText(r), r); assert.ok(!/[\r\n]/.test(r) && !cleanMod.INVISIBLE_TEST.test(r) && !cleanMod.containsLink(r)); }
  }
});

test('R4-1h the section sign is the word "section": the Section 8 voucher in its symbol form is held; other legal citations are not', async () => {
  for (const t of ['§8 tenant', '§ 8 tenant', 'tenant is § 8', 'sec §8', '§§8', 'S§8 inspection', 'Housing §8 voucher']) {
    const r = full('', t);
    assert.strictEqual(r.status, 'held', t); assert.ok(r.categories.includes('source_of_income'), t);
  }
  for (const t of ['Civil Code § 1950.5', 'see § 12 of the lease', 'per § 3 and § 4 of the manual', 'paragraph § 80', 'pg 5 §']) assert.strictEqual(heldFull(t), false, t);
});

test('R4-1i hostile symbol input stays inside the time budget: 20,000 symbols that expand, in both fields, with and without invisible characters', async () => {
  const worst = [cp(0xFDFD), cp(0x3392), cp(0x2122), cp(0x33A1), cp(0x2116), cp(0x1F190), cp(0x3300)];
  let slowest = 0;
  for (const mark of worst) {
    for (const glue of ['', cp(0x200B)]) {
      const text = (mark + glue).repeat(10000);
      const t0 = process.hrtime.bigint();
      const s = await prepareWorkOrderSummary({ name: text, description: text });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      slowest = Math.max(slowest, ms);
      assert.ok(['shown', 'held'].includes(s.status));
      assert.ok(s.meta.cause !== 'check_error' && s.meta.cause !== 'summary_error', `scanner error for ${mark.codePointAt(0).toString(16)}`);
      assert.ok(ms < 1500, `${ms} ms`);
    }
  }
  process.stdout.write(`      (${worst.length * 2} hostile inputs in both fields; slowest ${slowest.toFixed(0)} ms against the 1,500 ms budget)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// R4-2 / R4-3  AT-SIGN HOSTS AND WHAT FOLLOWS THE ENDING (Sentinel S2-D, Viper R1/R2, Asimov R4-2/R4-3)
// ════════════════════════════════════════════════════════════════════════
test('R4-2 the e-mail exemption in front of an at-sign needs a real host after it (a dot and a listed ending); otherwise the web-like word is replaced. Both directions', async () => {
  // replaced: the part after the at-sign is not a host
  for (const [t, want] of [
    ['evil.com@x', `${LINK_TEXT}@x`], ['paypal.support@a', `${LINK_TEXT}@a`], ['secure.bank@x', `${LINK_TEXT}@x`], ['see evil.zone@1 now', `see ${LINK_TEXT}@1 now`],
    ['see evil.zone@x.y now', `see ${LINK_TEXT}@x.y now`], ['evil.com@localhost', `${LINK_TEXT}@localhost`], ['login at chase-verify.com@x now', `login at ${LINK_TEXT}@x now`],
    ['evil.com@x.unlistedending', `${LINK_TEXT}@x.unlistedending`], ['evil.com@example.test', `${LINK_TEXT}@example.test`], ['Rincon.Support@x', `${LINK_TEXT}@x`], ['evil.com@é', `${LINK_TEXT}@é`],
  ]) {
    const c = cleanTextBoth(t);
    assert.strictEqual(c.shown, want, t);
    assert.strictEqual(cleanText(c.shown), c.shown, 'idempotent');
  }
  // a path after the domain: both are links in the end
  assert.strictEqual(clean1('see evil.com@x.com/login'), `see ${LINK_TEXT}@${LINK_TEXT}`);
  // kept as typed: ordinary e-mail addresses (Peter's decision), including a web-like word in front of the at-sign when the domain after it is a real host
  for (const k of ['name@example.com', 'sales.support@example.com', 'john.smith@gmail.com', 'first.last@sub.example.co.uk', 'bob.com@example.com', 'a_b-c.d@e-f.org', 'call john@example.com now', 'info.online@acme.io', 'Rincon.Support@rincon.org', 'maria.garcia@yahoo.com.mx', 'sam@example.test.']) {
    assert.strictEqual(clean1(k), k, `mangled: ${k}`);
    assert.strictEqual(cleanTextBoth(k).ambiguousLink, false, k);
  }
  // every listed ending counts as a real host after the at-sign, and every unlisted shape does not
  for (const e of cleanMod.TLDS) {
    if (!/^[a-z]+$/.test(e)) continue;
    assert.strictEqual(clean1(`evil.com@x.${e}`), `evil.com@x.${e}`, `a listed ending was not enough: ${e}`);
  }
  for (const bad of ['x', 'x.', 'x.y', 'x.1', '1', 'com', 'x.unlisted', 'x_y.com', '-x.com', '.com']) {
    assert.ok(clean1(`evil.com@${bad}`).startsWith(LINK_TEXT), `kept in front of "@${bad}"`);
  }
});

test('R4-3 the host ends at the first character after its ending that is not an ASCII letter or digit: a superscript, fraction, circled digit, other-script digit, ordinal sign or accented letter after the ending does not hide it', async () => {
  const tails = ['²', '³', '¹', '½', '¼', '①', '⑴', '٣', '१', 'ª', 'º', 'é', 'ñ', '⁴', '₂'];
  let n = 0;
  for (const ending of cleanMod.TLDS) {
    if (!/^[a-z]+$/.test(ending)) continue;
    for (const tail of tails) {
      const c = cleanTextBoth(`see evil.${ending}${tail} now`);
      assert.strictEqual(c.shown.startsWith(`see ${LINK_TEXT}`), true, `shown as typed: evil.${ending}+U+${tail.codePointAt(0).toString(16)} -> ${c.shown}`);
      assert.ok(c.shown.includes(cleanText(tail)), 'the character itself is kept (as the cleaner shows it)');
      assert.strictEqual(cleanText(c.shown), c.shown);
      n++;
    }
  }
  for (const t of ['go to evil.zone²', 'see chase.bank² now', 'visit paypal-secure.com³', 'see evil.zone½ now', 'evil.com²/login', 'evil.zone①/x?y=1']) {
    assert.ok(clean1(t).includes(LINK_TEXT) && !/evil|chase|paypal/.test(clean1(t)), `still visible: ${t} -> ${clean1(t)}`);
  }
  // a hyphen after the ending keeps its old meaning: the whole thing is one link, nothing is left behind
  for (const [t, want] of [['evil.com-login', LINK_TEXT], ['see paypal.support-verify now', `see ${LINK_TEXT} now`], ['Chase.bank-login', LINK_TEXT], ['evil.zone-2', LINK_TEXT]]) assert.strictEqual(clean1(t), want, t);
  // Title-case sentence-break shape followed by such a character is still flagged for a hold
  assert.strictEqual(cleanTextBoth('Leaking.Info² needed').ambiguousLink, true);
  // ordinary text with a number-like mark after a dot is untouched
  for (const t of ['approx.² here', 'room 1.5½ x 3', '5² ft room', '3.ml² of sealant', '12.5½ inch', 'No.5²', 'e.g.²', 'pg. 4¹']) {
    assert.strictEqual(clean1(t), t, `mangled: ${t}`);
  }
  process.stdout.write(`      (${n} ending + character combinations, none shown as typed)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// R4-4  THE v3 LIST IS PINNED (TARS gap, Judge fix 3)
// ════════════════════════════════════════════════════════════════════════
const liveTerms = () => {
  const m = new Map();
  for (const [cat, list] of Object.entries(T.TERMS)) m.set(cat, new Map(list.map((e) => [e.term, e.common])));
  return m;
};
const sentenceFor = (term) => `Tenant note for the unit: ${term.replace(/\*/g, 'ing')}, please schedule a visit.`;

test('R4-4a every v3 term of the snapshot is in the live list with the same common mark, every v3 pair-rule word, symbol and squashed phrase is still there, and each v3 term holds inside a natural sentence (so deleting one fails here)', async () => {
  assert.strictEqual(V3.version, 'wo-supp-v3');
  const live = liveTerms();
  let n = 0;
  for (const [cat, list] of Object.entries(V3.v3_additions)) {
    for (const raw of list) {
      const common = raw.endsWith(' [c]');
      const term = common ? raw.slice(0, -4) : raw;
      assert.ok(live.get(cat) && live.get(cat).has(term), `v3 term removed: ${cat} :: ${term}`);
      assert.strictEqual(live.get(cat).get(term), common, `common mark changed: ${term}`);
      const r = screenWorkOrderText({ title: '', description: sentenceFor(term) });
      assert.strictEqual(r.status, 'held', `v3 term does not hold in a sentence: ${term}`);
      assert.strictEqual(heldFull(sentenceFor(term)), true, `v3 term does not hold end to end: ${term}`);
      n++;
    }
  }
  assert.strictEqual(n, 331, 'the v3 snapshot lists 331 additions');
  // the v3 additions (331) are inside the snapshot's full list (1455), and the full list is inside the live list
  assert.strictEqual(Object.values(V3.terms).reduce((a, l) => a + l.length, 0), 1455);
  for (const [cat, list] of Object.entries(V3.terms)) for (const raw of list) {
    const common = raw.endsWith(' [c]'); const term = common ? raw.slice(0, -4) : raw;
    assert.ok(live.get(cat) && live.get(cat).has(term) && live.get(cat).get(term) === common, `snapshot term missing: ${cat} :: ${term}`);
  }
  // pair rules, symbols, squashed phrases of v3
  const rule = V3.pair_rules.find((r) => r.name === 'de-pais-es');
  assert.ok(rule, 'the v3 pair rule is in the snapshot');
  const liveRule = T.PAIR_RULES.find((r) => r.name === 'de-pais-es');
  for (const w of rule.a) assert.ok(liveRule.a.includes(w), `v3 pair rule word removed (a): ${w}`);
  for (const w of rule.b) assert.ok(liveRule.b.includes(w), `v3 pair rule word removed (b): ${w}`);
  assert.strictEqual(liveRule.window, rule.window); assert.strictEqual(liveRule.order, rule.order);
  for (const q of V3.squashed_phrases) assert.ok(T.SQUASHED_PHRASES.some((x) => x.phrase === q.phrase && x.cat === q.cat), `squashed phrase removed: ${q.phrase}`);
  for (const g of V3.symbols) {
    const group = T.SYMBOLS.filter((x) => x.cat === g.cat);
    for (const c of g.cps) assert.ok(group.some((x) => (x.cps || []).includes(c)), `symbol removed: U+${c.toString(16)}`);
    for (const [from, to] of g.ranges) assert.ok(group.some((x) => (x.ranges || []).some(([a, b]) => a <= from && b >= to)), `symbol range removed: U+${from.toString(16)}`);
  }
  // a few of the v3 words that hold ONLY because of their own entry (no other term catches the sentence): the ones the testers deleted in their experiment
  for (const [term, sentence] of [['hurting me', 'he keeps hurting me every night'], ['tiene pension', 'ella tiene pension'], ['had a gun', 'the man had a gun']]) {
    assert.ok([...live.values()].some((m) => m.has(term)), `${term} is gone`);
    assert.strictEqual(heldFull(sentence), true, sentence);
  }
  process.stdout.write(`      (${n} v3 terms, 1455 in the whole v3 snapshot, each v3 term held inside a sentence)\n`);
});

test('R4-4b every v4 term of the v4 snapshot is in the live list and holds inside a natural sentence (English and Spanish), the v4 pair rules keep every word of the snapshot, and a lone verb or noun does not hold', async () => {
  const live = liveTerms();
  let n = 0;
  for (const [cat, list] of Object.entries(V4.v4_additions)) {
    for (const raw of list) {
      const term = raw.endsWith(' [c]') ? raw.slice(0, -4) : raw;
      assert.ok(live.get(cat) && live.get(cat).has(term), `v4 term removed: ${cat} :: ${term}`);
      assert.strictEqual(heldFull(sentenceFor(term)), true, `v4 term does not hold: ${term}`);
      n++;
    }
  }
  assert.strictEqual(n, 56, 'the v4 additions are 56 terms');
  assert.strictEqual(Object.values(T.TERMS_V4_ADDITIONS).reduce((a, l) => a + l.length, 0), 56);
  assert.deepStrictEqual(V4.v4_pair_rule_names, ['violence-person-en', 'violence-person-es', 'de-pais-es-first-person']);
  assert.deepStrictEqual(T.PAIR_RULES_V4_ADDITIONS.map((r) => r.name), V4.v4_pair_rule_names);
  for (const name of V4.v4_pair_rule_names) {
    const snap = V4.pair_rules.find((r) => r.name === name);
    const now = T.PAIR_RULES.find((r) => r.name === name);
    assert.ok(snap && now, name);
    assert.strictEqual(now.window, snap.window); assert.strictEqual(now.order, snap.order); assert.strictEqual(now.cat, snap.cat);
    for (const w of snap.a) assert.ok(now.a.includes(w), `${name}: word removed (first list): ${w}`);
    for (const w of snap.b) assert.ok(now.b.includes(w), `${name}: word removed (second list): ${w}`);
  }
  // a lone verb, a lone noun: no hold
  for (const t of ['he punched the clock', 'kicked the can', 'the wife called about the leak', 'his mother called about the gate', 'tell the husband the plumber is coming', 'la madre llamo por la fuga', 'pega el letrero', 'soy el encargado', 'vengo manana a las nueve']) {
    assert.strictEqual(heldFull(t), false, `held: ${t}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// R4-5  TARS'S SURVIVING MUTANTS
// ════════════════════════════════════════════════════════════════════════
test('R4-5a an hour-based notice is held by the notice rule itself when it ends in to quit, vacate, pay, perform or cure (the last two are held by no other word), and an entry notice in hours is not', async () => {
  for (const t of ['48 hour notice to perform', '24 hours to cure', '72 hour written notice to cure', 'two hours to perform the repair', '12 hour notice to perform or quit', '24 hour notice to quit', '24 hours to vacate', '3 hour notice to pay', 'forty eight hour notice to cure', '36 hours to perform']) {
    const r = full('', t);
    assert.strictEqual(r.status, 'held', t); assert.ok(r.categories.includes('legal_eviction'), `${t} -> ${r.categories}`);
  }
  // perform and cure are held by the pattern alone: no feature-local term or shared term is the reason
  for (const t of ['48 hour notice to perform', '24 hours to cure']) {
    const r = screenWorkOrderText({ title: '', description: t });
    assert.deepStrictEqual(r.categories, ['legal_eviction'], t);
    const words = t.split(' ');
    for (let i = 0; i < words.length; i++) for (let len = 1; len <= 3; len++) {
      const piece = words.slice(i, i + len).join(' ');
      if (len === 3 && i + len > words.length) continue;
      assert.ok(!(liveTerms().get('legal_eviction').has(piece)), `a term catches "${piece}" by itself`);
    }
  }
  for (const t of ['24 hour notice of entry', '48 hour notice to enter', 'give 24 hour notice to the tenant', '24 hours before we arrive', '2 hour window for the plumber']) assert.strictEqual(heldFull(t), false, t);
});

test('R4-5b only the two-label shape with a letters-only or digits-only first label asks for the hold: longer chains, mixed first labels and hyphenated first labels are replaced as plain links and the block is not held for them', async () => {
  for (const t of ['Leaking.Info needed', 'Rincon.Info', 'xY.Info', '12.Info', 'Chase.Bank', '8.Today', 'Rincon.Support']) {
    const c = cleanTextBoth(t);
    assert.strictEqual(c.ambiguousLink, true, `not flagged: ${t}`);
    assert.ok(c.shown.includes(LINK_TEXT));
  }
  // replaced (a link either way), but NOT the sentence-break shape: no hold request
  for (const t of ['a.b.Info needed', 'Rincon.Info.Today', 'www5.Rincon.Info', 'sub.Rincon.Support', '5B.Info needed', 'A1.Info', 'a-b.Info needed', 'Rincon-Group.Info']) {
    const c = cleanTextBoth(t);
    assert.ok(c.shown.includes(LINK_TEXT), `not replaced: ${t} -> ${c.shown}`);
    assert.strictEqual(c.ambiguousLink, false, `wrongly flagged: ${t}`);
  }
  // lower-case, upper-case and anything with a tail are plain links, never the sentence-break shape
  for (const t of ['Rincon.info', 'Rincon.INFO', 'Rincon.Info/login', 'Rincon.Info:80', 'Rincon.Info?x=1']) assert.strictEqual(cleanTextBoth(t).ambiguousLink, false, t);
});

// ════════════════════════════════════════════════════════════════════════
// R4-6  VIOLENCE DONE TO A NAMED PERSON (Viper R3, Asimov R4-4)
// ════════════════════════════════════════════════════════════════════════
const VIPER_38 = ['he hits his wife', 'she hits her husband', 'the neighbor beats his wife every night', 'my dad hits my mom', 'my father beats my mother', 'he slapped his girlfriend', 'he punched his wife', 'he choked his girlfriend', 'he threatens his wife', 'he abuses his wife',
  'he is abusive to his wife', 'abusive husband in 3B', 'abusive boyfriend next door', 'my boyfriend is abusive', 'she is abusive', 'he abuses me', 'being abused by her husband', 'he assaulted her', 'she was assaulted', 'sexual assault last week', 'she was raped', 'he raped her', 'molested',
  'my uncle touched me', 'child abuse in the unit', 'elder abuse', 'he hit the kids', 'he hits the children', 'spanking', 'bruises on her arms', 'black eye', 'she had a black eye', 'she has bruises', 'broken nose', 'busted lip', 'he broke her arm', 'she was injured by him', 'he put her in the hospital'];
const ORDINARY_DAMAGE = ['he punched a hole in the wall', 'someone kicked in the front door', 'the door was kicked open by the contractor', 'hit by a car, the gate is bent', 'truck hit the fence', 'I hit the mailbox with my car', 'hit the water main', 'the beat of the pump is loud', 'he slapped paint on the wall', 'pushed the button', 'grabbed the wrench',
  'the dog attacked the garbage cans', 'hit the wall near the mother-in-law unit', 'Call my mother at 5', 'Dad will meet the plumber', 'push button on the intercom for the grandmother unit', 'hurt back lifting the dishwasher, tell his wife', 'the tree branch hit the roof of the garage',
  'beat the heat with a new fan', 'attacked by wasps near the eaves', 'sister company will send a crew', 'my brother in law is the contractor'];

test('R4-6a Viper\'s 38-item list (violence done to a wife, husband, partner, parent or child, molestation, spanking, the injuries) is held, through the real path and the screen alone; ordinary damage with no person passes', async () => {
  assert.strictEqual(VIPER_38.length, 38);
  for (const t of VIPER_38) {
    assert.strictEqual(heldFull(t), true, `shown: ${t}`);
    assert.strictEqual(screenWorkOrderText({ title: '', description: t }).status, 'held', `screen alone: ${t}`);
    const r = full('', t);
    assert.ok(r.categories.length >= 1);
  }
  // the 14 that were shown before this round are held by the v4 additions, not by an older term
  const FOURTEEN = ['he hits his wife', 'the neighbor beats his wife every night', 'my dad hits my mom', 'my father beats my mother', 'he slapped his girlfriend', 'he punched his wife', 'he choked his girlfriend', 'molested', 'my uncle touched me', 'spanking', 'broken nose', 'busted lip', 'he broke her arm', 'she was injured by him'];
  for (const t of FOURTEEN) assert.ok(full('', t).categories.includes('safety_violence'), t);
  for (const t of ORDINARY_DAMAGE) assert.strictEqual(heldFull(t), false, `held: ${t}`);
  process.stdout.write(`      (${VIPER_38.length} violence items held; ${ORDINARY_DAMAGE.length} ordinary damage and family-word neighbours pass)\n`);
});

test('R4-6b the violence pair rules: every verb of the v4 snapshot with every person noun of the snapshot within three words is held (English and Spanish), a person noun after the window or before the verb is not', async () => {
  const en = V4.pair_rules.find((r) => r.name === 'violence-person-en');
  const es = V4.pair_rules.find((r) => r.name === 'violence-person-es');
  assert.ok(en.a.length >= 37 && en.b.length >= 35 && es.a.length >= 22 && es.b.length >= 31, 'the snapshot lists are the ones built');
  for (const verb of en.a) for (const noun of en.b) {
    assert.strictEqual(screenWorkOrderText({ title: '', description: `he ${verb} his ${noun}` }).status, 'held', `${verb} ${noun}`);
  }
  for (const verb of es.a) for (const noun of es.b) {
    assert.strictEqual(screenWorkOrderText({ title: '', description: `el ${verb} a su ${noun}` }).status, 'held', `${verb} ${noun}`);
  }
  // outside the window of three words, or the noun first: nothing
  for (const t of ['he hits the very old door of his wife', 'wife hits', 'mother kicked', 'the plumber hit the pipe while the wife and the husband waited outside', 'pega la mica en el cuarto de la madre', 'la madre pega']) assert.strictEqual(heldFull(t), false, t);
  // neither list contains the ordinary words the stop rule found
  for (const w of ['grab', 'grabs', 'grabbed', 'push', 'pushes', 'pushed', 'attack', 'attacks', 'baby']) assert.ok(!en.a.includes(w) && !en.b.includes(w), `ordinary word on the English list: ${w}`);
  for (const w of ['mata', 'mato', 'lastima', 'lastimo', 'ataca', 'agarra']) assert.ok(!es.a.includes(w), `ordinary word on the Spanish list: ${w}`);
});

// ════════════════════════════════════════════════════════════════════════
// R4-7  FIRST-PERSON SPANISH (Viper R4)
// ════════════════════════════════════════════════════════════════════════
test('R4-7 first-person Spanish forms of what is already held in the third person: "soy de Mexico", "naci en Honduras", "vengo de El Salvador", "no tengo papeles / documentos"; the ordinary neighbours pass', async () => {
  const hold = ['soy de Mexico y necesito reparar la ventana', 'soy de El Salvador', 'naci en Honduras', 'nacimos en Mexico', 'vengo de Mexico', 'vine de Guatemala', 'venimos de El Salvador', 'vinimos de Guatemala', 'eres de Colombia', 'viniste de Peru', 'nacieron en Mexico',
    'no tengo papeles', 'no tengo documentos', 'no tenemos papeles', 'no tenemos documentos', 'No tengo papeles para el contrato del depa'];
  for (const t of hold) assert.strictEqual(heldFull(t), true, t);
  // the third-person forms are still held
  for (const t of ['somos de Guatemala', 'mi familia es de Mexico', 'sin papeles', 'sin documentos', 'no tiene documentos', 'vino de Guatemala']) assert.strictEqual(heldFull(t), true, t);
  for (const t of ['soy el encargado del edificio', 'soy el plomero de la compania', 'vengo manana a las nueve', 'vine a revisar el boiler', 'naci aqui pero la puerta no cierra', 'no tengo llave de la puerta', 'no tengo agua caliente', 'no tengo luz en la cocina', 'no tengo el recibo de la renta', 'el piso es de madera', 'la tuberia viene de la calle']) {
    assert.strictEqual(heldFull(t), false, `held: ${t}`);
  }
  const rule = T.PAIR_RULES_V4_ADDITIONS.find((r) => r.name === 'de-pais-es-first-person');
  assert.deepStrictEqual(rule.b, T.PAIR_RULES.find((r) => r.name === 'de-pais-es').b, 'the same countries as the third-person rule');
  for (const w of ['fui', 'fuimos', 'voy', 'estoy', 'vivo']) assert.ok(!rule.a.includes(w), `an ambiguous verb is on the first-person list: ${w}`);
});

// ════════════════════════════════════════════════════════════════════════
// R4-8  SECTION 8 UNDER THE PROGRAM'S OWN NAMES (Viper R5)
// ════════════════════════════════════════════════════════════════════════
test('R4-8 Section 8 program jargon (HQS, HAP contract, PHA inspection, EHV, LIHTC, assisted housing, tax credit unit, family self sufficiency, FSS program, VA benefits) is held; the ordinary words next to them pass', async () => {
  for (const t of ['HQS inspection Friday', 'HQS', 'HAP contract', 'HAP contracts', 'HAP payment', 'PHA inspection', 'PHA inspections next week', 'EHV', 'EHV tenant', 'LIHTC', 'LIHTC unit', 'assisted housing', 'tax credit unit', 'family self sufficiency', 'FSS program', 'VA benefits']) {
    const r = full('', t);
    assert.strictEqual(r.status, 'held', t); assert.ok(r.categories.includes('source_of_income'), `${t} -> ${r.categories}`);
  }
  for (const t of ['hap hazard repair', 'tax credit received for the solar panels', 'assisted living facility next door', 'family room needs paint', 'self closing gate', 'program the thermostat', 'inspection passed']) assert.strictEqual(heldFull(t), false, t);
});

// ════════════════════════════════════════════════════════════════════════
// R4-9  A CLEANER-REQUESTED HOLD HAS ITS OWN CAUSE (TARS info item)
// ════════════════════════════════════════════════════════════════════════
test('R4-9 a missing space after a full stop (the sentence-break shape) and a web-like fragment left by the cut are recorded with the cause link_shape, not local_screen: the audit row keeps its 11 keys, no category name, medium risk; sensitive-word holds still say local_screen', async () => {
  const KEYS = ['latchel_job_id', 'trigger_source', 'mode', 'result', 'cause', 'common_word_only', 'screen_version', 'truncated', 'fallback_getjob_used', 'pod_unassigned', 'on_downgraded', 'trace'].sort();
  const names = screenMod.CATEGORY_VOCABULARY;
  for (const [name, description, cause] of [['Visit', 'Leaking.Info needed', 'link_shape'], ['Rincon.Support', 'Fine text.', 'link_shape'], ['Visit', `${'a'.repeat(297)}.coder`, 'link_shape'], ['Visit', 'tenant uses a wheelchair', 'local_screen'], ['Visit', 'paint the walls white', 'local_screen']]) {
    for (const mode of ['shadow', 'on']) {
      const r = await K.send({ mode, job: baseJob({ name, description }) });
      const ev = auditEvents(DESC_ACTION);
      assert.strictEqual(ev.length, 1);
      assert.deepStrictEqual(Object.keys(ev[0].details).sort(), KEYS);
      assert.strictEqual(ev[0].details.cause, cause, `${description}`);
      assert.strictEqual(ev[0].details.result, 'held');
      assert.strictEqual(ev[0].risk_level, 'medium');
      assert.strictEqual(ev[0].details.common_word_only, description.includes('white'));
      const everything = JSON.stringify([auditEvents(), H.db.writes, H.logs, H.nm.sent]);
      for (const c of names) assert.ok(!everything.includes(`"${c}"`), `category name ${c} stored or logged`);
      assert.ok(r.email, 'the alert is still sent');
    }
  }
  const s = await prepareWorkOrderSummary({ name: 'Visit', description: 'Leaking.Info needed' });
  assert.strictEqual(s.meta.cause, 'link_shape'); assert.strictEqual(s.meta.common_word_only, false); assert.deepStrictEqual(s.lines, [HEADER, HELD_NOTICE]);
});

// ════════════════════════════════════════════════════════════════════════
// R4-10  THE NESTING WORDING MATCHES THE SIX PASSES THE CODE ALLOWS (R4-6)
// ════════════════════════════════════════════════════════════════════════
test('R4-10 five levels of nesting settle and six do not (entities escaped five or six times over, tags assembled five or six levels deep); the cleaner header, the SPEC and the inventory say six', async () => {
  const entity = (levels) => `&${'amp;'.repeat(levels - 1)}lt;b&${'amp;'.repeat(levels - 1)}gt;`;
  const tags = (levels) => { let t = 'x'; for (let i = 0; i < levels; i++) t = `<b${t}>`; return t; };
  for (const levels of [1, 2, 3, 4, 5]) { assert.doesNotThrow(() => cleanTextBoth(entity(levels)), `${levels} entity levels`); assert.doesNotThrow(() => cleanTextBoth(tags(levels)), `${levels} tag levels`); }
  for (const levels of [6, 7, 8, 12]) {
    for (const make of [entity, tags]) assert.throws(() => cleanTextBoth(make(levels)), (e) => e instanceof cleanMod.CleanError && e.message === 'clean_did_not_settle', `${levels} levels settled`);
  }
  assert.strictEqual(cleanMod.MAX_PASSES, 6);
  const header = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-clean.js'), 'utf8');
  assert.ok(!/five or more levels/i.test(header.replace(/An earlier version of[\s\S]*?six passes in all\.\)/, '')), 'the cleaner header still says five or more levels');
  assert.ok(/six or more/i.test(header));
  const spec = readDoc('projects/hub/work-order-notes-alert-SPEC.md');
  assert.ok(!/five or more levels/i.test(spec), 'the SPEC still says five or more levels');
  assert.ok(/six or more levels/i.test(spec), 'the SPEC says six or more levels');
});

// ════════════════════════════════════════════════════════════════════════
// R4-11  THE DOCUMENTS SAY WHAT THE CODE DOES (R4-6)
// ════════════════════════════════════════════════════════════════════════
test('R4-11 the documents: SPEC status line names the fourth fix round and wo-supp-v4 (additions: 56 terms); the exhaustive-sweep wording says what is proved; Section 9 records the measurement endings that are real country domains; no stale label or claim remains', async () => {
  const spec = readDoc('projects/hub/work-order-notes-alert-SPEC.md');
  const head = spec.split('\n').slice(0, 4).join('\n');
  assert.ok(/fourth fix round/i.test(head), 'the status line names the fourth fix round');
  assert.ok(spec.includes('wo-supp-v4') && spec.includes('link_shape'));
  assert.ok(spec.includes('(version `wo-supp-v4`: v1, plus the 213 v2 terms'), 'the SPEC describes the current list as wo-supp-v4');
  assert.ok(/56 terms/.test(spec) && /three pair rules/.test(spec), 'the v4 additions are counted');
  assert.ok(/four readings/i.test(spec) || /symbols reading/i.test(spec), 'the SPEC describes the symbols reading');
  assert.ok(spec.includes('733 characters over 6 lines'));
  for (const rel of ['projects/hub/work-order-notes-alert-SPEC.md', 'compliance/work-order-note-alerts-data-inventory.md']) {
    const text = readDoc(rel);
    assert.ok(!/17,?144 variants/.test(text), `${rel} still carries the overstated sweep claim`);
    assert.ok(!/710 to 730|about 710|697 characters|203 (added|terms)|203 new/.test(text), `${rel} carries a stale number`);
  }
  const review = readDoc('compliance/work-order-note-alerts-description-governance-review.md');
  const sec9 = review.slice(review.indexOf('## 9'), review.indexOf('## 10'));
  assert.ok(/ml, ma, mw, mv, kw/.test(sec9) && /country domain/i.test(sec9), 'Section 9 records the measurement endings that are also real country domains');
  const inv = readDoc('compliance/work-order-note-alerts-data-inventory.md');
  assert.ok(inv.includes('wo-supp-v4') && /fourth fix round/i.test(inv), 'the data inventory addendum is current');
  assert.ok(/link_shape/.test(inv), 'the data inventory lists the new cause value');
});

runner.run();
