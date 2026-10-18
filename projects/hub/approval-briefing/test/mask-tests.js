#!/usr/bin/env node
/**
 * test/mask-tests.js
 *
 * Tests for the never-store mask (maskNeverStore in lib/work-order-text-clean.js) that
 * runs when the owner has turned the content screen off. Round 5 of the screen-off
 * switch (TARS 1 and 2, Judge fixes 1 and 2, Sentinel S3-1, Asimov U-2 and U-3):
 *
 *   C1  a card number is masked in ANY grouping (13 to 19 digits, one space or dash between
 *       any two digits, valid check digit): the named shapes and 300 random numbers per grouping;
 *       and a card written the usual way is found even straight after another number
 *   C2  the card rule is kept in step with the old content screen's own card test
 *   C3  unit, ticket and serial numbers are not masked because they LOOK like a card
 *       (no card-prefix rule); the residual rate is the check digit's own, the same as the screen's
 *   C4  false-positive corpus: 300 ordinary synthetic work orders, 0 changed
 *   C5  passwords: filler words, "reset to", an everyday first word after a colon
 *   C6  bare SWIFT keyword; the date exemption after account / routing is range-checked
 *   C7  what the mask still does not catch is pinned (the SPEC lists the same)
 *   C8  invariants: idempotent, linear, never throws, over generated strings
 *   C9  the SPEC says what the code does
 *   C10 round 6: a Social Security number beside a card or a list of numbers is masked in ONE pass with it (TARS bug 1,
 *       Judge fix 1, Asimov U-2a): no digit of either is left, in both orders, with and without the word "ssn"
 *   C11 round 6: the rules that need a keyword run before the password rules, and no password reading takes another rule's
 *       keyword as its value or swallows it (TARS / Sentinel S3-7, Judge fix 2, Asimov U-2b)
 *   C12 round 6: a password straight after "to" / "now" / "be" / "as", several passwords in a row, "complete" (TARS bug 2 and 3,
 *       Judge fix 3, Asimov R5-3)
 *
 * SAFETY: no real email, no real database, no real Latchel, no model, no .env
 * read. All text is invented.
 *
 * Run alone:  node projects/hub/approval-briefing/test/mask-tests.js
 */

'use strict';

const K = require('./test-kit'); // first: sets env, stubs, tripwires
const { H, assert, path, rng } = K;
const fs = require('fs');
const cleanMod = H.load('lib/work-order-text-clean.js');
const screenMod = H.load('lib/work-order-text-screen.js');

const { maskNeverStore, cleanTextUnscreened, cleanText, MASK_TEXT: M, luhnOk } = cleanMod;
const REPO = path.resolve(H.HUB_DIR, '../..');
const readDoc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const runner = K.makeRunner('Work Order Alert - the never-store mask (rounds 5 and 6: cards in any grouping, SSN and card in one pass, keyword rules before password rules, passwords, SWIFT, dates)');
const { test } = runner;

// ─── generators ─────────────────────────────────────────────────────────────
const make = (seed) => {
  const next = rng(seed);
  const ri = (a, b) => a + Math.floor(next() * (b - a + 1));
  const digits = (n) => Array.from({ length: n }, () => String(Math.floor(next() * 10))).join('');
  const withCheck = (body) => { for (let d = 0; d < 10; d++) if (luhnOk(body + d)) return body + d; throw new Error('no check digit'); };
  const valid = (len) => withCheck(digits(len - 1));
  const invalid = (len) => { let n = digits(len); while (luhnOk(n)) n = digits(len); return n; };
  const pick = (arr) => arr[Math.floor(next() * arr.length)];
  return { next, ri, digits, valid, invalid, pick, withCheck };
};
const split = (num, groups, sep) => { let p = 0; return groups.map((k) => { const x = num.slice(p, p + k); p += k; return x; }).join(sep); };

/**
 * An independent oracle for the second card reading (a card written the usual way, wherever it starts inside a run of
 * digit groups): true when some window of the groups of an ASCII run is one group of 13 to 19 digits, 4-4-4-x (x 1 to 4),
 * 4-4-4-4-3 or 4-6-5, with a valid check digit.
 */
function usualLayoutCardInside(text) {
  for (const run of text.match(/\d+(?:[ -]\d+)*/g) || []) {
    const groups = run.split(/[ -]/);
    for (let a = 0; a < groups.length; a++) {
      let digits = '';
      for (let b = a; b < groups.length; b++) {
        digits += groups[b];
        if (digits.length > 19) break;
        const lens = groups.slice(a, b + 1).map((x) => x.length);
        const layout = lens.length === 1 || (lens.length >= 4 && lens.slice(0, -1).every((n) => n === 4) && lens[lens.length - 1] >= 1 && lens[lens.length - 1] <= 4)
          || (lens.length === 3 && lens[0] === 4 && lens[1] === 6 && lens[2] === 5);
        if (digits.length >= 13 && layout && luhnOk(digits)) return true;
      }
    }
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════
// C1. CARD NUMBERS IN ANY GROUPING
// ════════════════════════════════════════════════════════════════════════
const VISA16 = '4111111111111111';      // valid check digit
const AMEX15 = '378282246310005';       // valid check digit

test('C1a the named shapes, every one with a valid check digit, are replaced as a whole (TARS 1 / Judge fix 1)', async () => {
  assert.ok(luhnOk(VISA16) && luhnOk(AMEX15));
  const named = [
    '4111 11111 11111 11', '41111 11111 11111 1', '411 111 111 111 111 1', '41 11 11 11 11 11 11 11', '4111-1111-1111-1111', '4111111111111111',
    '4111 1111 1111 1111', '4111 1111 11111111', '41111111 11111111', '4111 111111111111', '411111 1111111111', '411 111 111 111 1111',
    '4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1', '4-1-1-1-1-1-1-1-1-1-1-1-1-1-1-1', '41-11-11-11-11-11-11-11', '4111-1111 1111-1111',
  ];
  for (const n of named) {
    assert.ok(luhnOk(n.replace(/[ -]/g, '')), `fixture without a valid check digit: ${n}`);
    assert.strictEqual(maskNeverStore(`paid with ${n} today`), `paid with ${M} today`, n);
    assert.strictEqual(maskNeverStore(n), M, n);
    assert.strictEqual(cleanTextUnscreened(`paid with ${n} today`), `paid with ${M} today`, `through the whole unscreened cleaning: ${n}`);
  }
  // American Express in its 4-6-5 shape and in other groupings
  for (const n of ['3782 822463 10005', '378282246310005', '3782-822463-10005', '37828 22463 10005', '3782 8224 6310 005', '378 282 246 310 005']) {
    assert.ok(luhnOk(n.replace(/[ -]/g, '')), n);
    assert.strictEqual(maskNeverStore(`amex? ${n}!`), `amex? ${M}!`, n);
  }
  // the shortest and the longest card, 13 and 19 digits
  const n13 = '4222222222222';
  assert.ok(luhnOk(n13));
  assert.strictEqual(maskNeverStore(`x ${n13} y`), `x ${M} y`);
  assert.strictEqual(maskNeverStore(`x 4222 2222 22222 y`), `x ${M} y`);
  const n19 = make(19).valid(19);
  assert.strictEqual(n19.length, 19);
  assert.strictEqual(maskNeverStore(`x ${n19} y`), `x ${M} y`);
  assert.strictEqual(maskNeverStore(`x ${split(n19, [4, 4, 4, 4, 3], ' ')} y`), `x ${M} y`);
});

const GROUPINGS = {
  '4-4-4-4': [4, 4, 4, 4], '4-5-5-2': [4, 5, 5, 2], '5-5-5-1': [5, 5, 5, 1], '3-3-3-3-3-1': [3, 3, 3, 3, 3, 1], '2 x 8': [2, 2, 2, 2, 2, 2, 2, 2],
  'amex 4-6-5': [4, 6, 5], '4-4-8': [4, 4, 8], '8-8': [8, 8], '4-12': [4, 12], '6-10': [6, 10], '3-3-3-3-4': [3, 3, 3, 3, 4],
  'one group of 16': [16], 'one group of 13': [13], 'one group of 19': [19], '4-4-4-4-3': [4, 4, 4, 4, 3], '4-4-4-3': [4, 4, 4, 3], '4-4-4-1': [4, 4, 4, 1],
  '1 x 16': Array(16).fill(1), '2-3-4-5-2': [2, 3, 4, 5, 2], '7-9': [7, 9], '9-10': [9, 10], '6-7': [6, 7], '5-4-5': [5, 4, 5], '3-2-4-4-3 (SSN-shaped start)': [3, 2, 4, 4, 3],
};

test('C1b 300 random numbers with a valid check digit per grouping, with a space and with a dash between the groups: 300 of 300 masked (TARS 1)', async () => {
  const g = make(20261018);
  const lines = [];
  for (const [name, groups] of Object.entries(GROUPINGS)) {
    const len = groups.reduce((a, b) => a + b, 0);
    let hit = 0;
    let tried = 0;
    for (let i = 0; i < 300; i++) {
      const num = g.valid(len);
      for (const sep of groups.length === 1 ? [' '] : [' ', '-']) {
        const text = `paid with ${split(num, groups, sep)} today`;
        tried++;
        if (maskNeverStore(text) === `paid with ${M} today`) hit++;
        else assert.fail(`not masked (${name}): ${text} => ${maskNeverStore(text)}`);
      }
    }
    assert.strictEqual(hit, tried);
    lines.push(`${name} ${hit / (tried / 300)}/300`);
  }
  process.stdout.write(`      (per grouping, numbers masked out of 300 with a valid check digit, each tried with a space and with a dash: ${lines.join('; ')})\n`);
});

test('C1c 3,000 random groupings (1 to 8 digits per group, 13 to 19 digits, valid check digit, space or dash): 3,000 of 3,000 masked, even when a group of the number looks like an SSN', async () => {
  const g = make(1017);
  let masked = 0;
  for (let i = 0; i < 3000; i++) {
    const len = g.ri(13, 19);
    const num = g.valid(len);
    const groups = [];
    for (let left = len; left > 0;) { const k = Math.min(left, g.ri(1, 8)); groups.push(k); left -= k; }
    const sep = g.next() < 0.5 ? ' ' : '-';
    const text = `paid with ${split(num, groups, sep)} today`;
    assert.strictEqual(maskNeverStore(text), `paid with ${M} today`, text);
    masked++;
  }
  assert.strictEqual(masked, 3000);
});

test('C1d a card number works with digits of any script and with the other dash characters', async () => {
  const arabic = VISA16.replace(/\d/g, (d) => String.fromCodePoint(0x660 + Number(d)));
  assert.strictEqual(maskNeverStore(`x ${split(arabic, [4, 4, 8], ' ')} y`), `x ${M} y`);
  assert.strictEqual(maskNeverStore(`x ${split(VISA16, [4, 4, 4, 4], '–')} y`), `x ${M} y`);
  assert.strictEqual(maskNeverStore(`x ${split(VISA16, [8, 8], '−')} y`), `x ${M} y`);
});

test('C1e a card written the usual way (one group, 4-4-4-x, American Express 4-6-5) is found even straight after another number or before one, with no card word: the named cases and 2,400 generated ones, none missed', async () => {
  for (const [input, expected] of [
    ['apt 12 4111 1111 1111 1111', `apt 12 ${M}`], ['unit 305 4111111111111111', `unit 305 ${M}`], ['ticket 4455 4111 1111 1111 1111', `ticket 4455 ${M}`],
    ['pay 88213 3782 822463 10005', `pay 88213 ${M}`], ['1 4222222222222 on', `1 ${M} on`], ['4111 1111 1111 1111 204 done', `${M} 204 done`],
  ]) assert.strictEqual(maskNeverStore(input), expected, input);
  const g = make(555);
  const noiseNums = ['12', '204', '4455', '88213', '1', '99', '7', '2026', '12B', '305', '951-555-0142'];
  let n = 0;
  for (let i = 0; i < 2400; i++) {
    const sep = g.next() < 0.5 ? ' ' : '-';
    let card;
    const style = i % 3;
    if (style === 0) card = g.valid(g.pick([13, 15, 16, 19]));
    else if (style === 1) { const long = g.next() < 0.5; card = split(g.valid(long ? 19 : 16), long ? [4, 4, 4, 4, 3] : [4, 4, 4, 4], sep); }
    else card = split(g.valid(15), [4, 6, 5], sep);
    const pre = g.next() < 0.6 ? `${g.pick(noiseNums)} ` : '';
    const post = g.next() < 0.4 ? ` ${g.pick(noiseNums)}` : '';
    const text = `ref ${pre}${card}${post} end`;
    const out = maskNeverStore(text);
    assert.ok(out.includes(M), `not masked: ${text} => ${out}`);
    assert.ok(!out.replace(/\D/g, '').includes(card.replace(/\D/g, '').slice(0, 13)), `digits of the card are left in: ${text} => ${out}`);
    n++;
  }
  assert.strictEqual(n, 2400);
});

// ════════════════════════════════════════════════════════════════════════
// C2. THE CARD RULE IS KEPT IN STEP WITH THE OLD SCREEN'S OWN CARD TEST
// ════════════════════════════════════════════════════════════════════════
test('C2a the check digit routine is the screen\'s own: the same answer for 20,000 random digit strings of 8 to 24 digits', async () => {
  const g = make(31);
  const screenLuhn = screenMod._internals.luhnOk;
  let agree = 0;
  for (let i = 0; i < 20000; i++) {
    const n = g.digits(g.ri(8, 24));
    assert.strictEqual(luhnOk(n), screenLuhn(n), n);
    agree++;
  }
  assert.strictEqual(agree, 20000);
  // and a list of known cards
  for (const n of [VISA16, AMEX15, '5555555555554444', '4012888888881881', '4222222222222']) assert.strictEqual(luhnOk(n) && screenLuhn(n), true);
});

test('C2b the screen\'s source still has the card and SSN patterns this rule is written against; if it changes, this test fails and the mask must be reviewed', async () => {
  const src = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-screen.js'), 'utf8');
  assert.ok(src.includes('const CARD_PATTERN = /(?<!\\d)(?:\\d[ -]?){12,18}\\d(?!\\d)/g;'), 'the screen\'s CARD_PATTERN changed');
  assert.ok(src.includes('digits.length >= 13 && digits.length <= 19 && luhnOk(digits)'), 'the screen\'s card length / check digit test changed');
  assert.ok(src.includes('const SSN_PATTERN = /(?<!\\d)\\d{3}[- ]\\d{2}[- ]\\d{4}(?!\\d)/;'), 'the screen\'s SSN_PATTERN changed');
  const clean = fs.readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-clean.js'), 'utf8');
  assert.ok(clean.includes('if (total > 19) break;') && clean.includes('if (total >= 13)'), 'the mask\'s window of 13 to 19 digits');
});

test('C2c differential: on 40,000 random strings of digit groups, spaces, dashes and plain words, the mask changes the text exactly when the screen\'s own SSN / card test flags it OR a card written the usual way sits inside (checked by an independent oracle); no card word is used, so only the pattern rules apply', async () => {
  const g = make(4242);
  const holdsFinancial = (s) => { const r = screenMod.screenWorkOrderText({ title: '', description: s }); return r.status === 'held' && r.categories.includes('financial_id'); };
  let both = 0;
  let neither = 0;
  let onlyUsual = 0;
  for (let i = 0; i < 40000; i++) {
    const parts = [];
    const groupsN = g.ri(1, 9);
    for (let k = 0; k < groupsN; k++) {
      parts.push(g.next() < 0.1 ? g.valid(g.ri(13, 19)) : g.digits(g.ri(1, 8)));
      const r = g.next();
      parts.push(r < 0.55 ? ' ' : r < 0.9 ? '-' : r < 0.95 ? '  ' : ' - ');
    }
    parts.pop();
    const s = `${g.pick(['ref ', 'unit ', '', 'ticket '])}${parts.join('')}${g.pick(['', ' ok', ' and more', ' x'])}`;
    const flagged = holdsFinancial(s);
    const usual = usualLayoutCardInside(s);
    const changed = maskNeverStore(s) !== s;
    assert.strictEqual(changed, flagged || usual, `mask ${changed ? 'changed' : 'left'} it, screen ${flagged ? 'flags' : 'passes'} it, usual-layout oracle ${usual}: ${JSON.stringify(s)}`);
    if (flagged) assert.ok(changed, 'every string the screen flags is masked');
    if (flagged) both++; else if (usual) onlyUsual++; else neither++;
  }
  assert.ok(both > 5000 && neither > 5000, `${both} / ${neither}`);
  process.stdout.write(`      (40,000 random strings: ${both} flagged by the screen and masked, ${onlyUsual} masked only because a card written the usual way sits inside, ${neither} passed by both, 0 differences)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// C3. UNIT, TICKET AND SERIAL NUMBERS ARE NOT MASKED BECAUSE THEY LOOK LIKE A CARD
// ════════════════════════════════════════════════════════════════════════
const LOOKS_LIKE_A_CARD_BUT_IS_NOT = [
  'unit 4521 4522 4523 4524', 'Units 4101 4102 4103 4104', 'ticket 4421-5532-6643-7754', 'serial 4482-9913-2201-7788', 'Units 1201 1202 1203 1204', 'units 2201 2202 2203 2204',
  'units 5101 5102 5103 5104', 'Units 3401 3402 3403 3405', 'Units 3701 3702 3703 3704', 'Units 6501 6502 6503 6504', 'Units 6011 6012 6013 6015', 'ticket 4111-1111-1111-1112',
];

test('C3a unit, ticket and serial numbers written 4-4-4-4 are left alone when the check digit fails, whatever their first digits look like (TARS 2 / Judge fix 2)', async () => {
  for (const s of LOOKS_LIKE_A_CARD_BUT_IS_NOT) {
    const n = s.replace(/\D/g, '');
    assert.strictEqual(luhnOk(n), false, `fixture passes the check digit by chance: ${s}`);
    assert.strictEqual(maskNeverStore(s), s, s);
    assert.strictEqual(cleanTextUnscreened(s), s, `through the whole unscreened cleaning: ${s}`);
  }
  // a card word still masks without a check digit (the word says it is a card)
  for (const s of ['card 4111 1111 1111 1112', 'visa 4521 4522 4523 4524', 'mastercard: 5101 5102 5103 5104', 'Amex 3401 3402 3403 3404', 'discover 6011 6012 6013 6014', 'tarjeta 4521-4522-4523-4524', 'credit card 4521 4522 4523 4524', 'debit card 4521 4522 4523 4524']) {
    assert.strictEqual(maskNeverStore(s), `${s.split(/ (?=\d)/)[0]} ${M}`, s);
  }
  // when a list happens to pass the check digit, it is masked, like a single number would be (listed as a known false positive in the SPEC)
  assert.ok(luhnOk('4111111111111111'));
  assert.strictEqual(maskNeverStore('units 4111 1111 1111 1111'), `units ${M}`);
});

test('C3b the residual rate on random lists is the check digit\'s own (about 1 in 10) and, for every shape where only the screen\'s reading applies, exactly the old screen\'s rate on the same lists; comma-separated shapes are 0; lists of 5 or more 4-digit numbers get the second chance the SPEC discloses', async () => {
  const g = make(20261017);
  const num = (n) => String(g.ri(10 ** (n - 1), 10 ** n - 1));
  const holdsFinancial = (s) => { const r = screenMod.screenWorkOrderText({ title: '', description: s }); return r.status === 'held' && r.categories.includes('financial_id'); };
  const shapes = [
    // [name, generator, [lowest, highest] expected rate, parity with the old screen on every list]
    ['four 4-digit numbers, spaces', () => `units ${[1, 2, 3, 4].map(() => num(4)).join(' ')}`, [0.07, 0.14], true],
    ['four 4-digit numbers, dashes', () => `ticket ${[1, 2, 3, 4].map(() => num(4)).join('-')}`, [0.07, 0.14], true],
    ['four consecutive 4-digit unit numbers', () => { const b = g.ri(1000, 9000); return `Units ${b} ${b + 1} ${b + 2} ${b + 3}`; }, [0.1, 0.3], true],
    ['four 4-digit numbers, commas', () => `units ${[1, 2, 3, 4].map(() => num(4)).join(', ')}`, [0, 0], true],
    ['5 to 10 three-digit unit numbers, spaces', () => `units ${Array.from({ length: g.ri(5, 10) }, () => num(3)).join(' ')}`, [0.06, 0.14], true],
    ['5 to 10 three-digit unit numbers, commas', () => `units ${Array.from({ length: g.ri(5, 10) }, () => num(3)).join(', ')}`, [0, 0], true],
    ['two 7-digit work order numbers, spaces', () => `WO ${num(7)} ${num(7)}`, [0.06, 0.14], true],
    ['two 7-digit work order numbers, commas', () => `WO ${num(7)}, ${num(7)}`, [0, 0], true],
    ['phone and extension', () => `call ${g.ri(200, 999)} ${g.ri(200, 999)} ${num(4)} ${num(4)}`, [0.06, 0.14], true],
    ['five 4-digit numbers, spaces', () => `units ${[1, 2, 3, 4, 5].map(() => num(4)).join(' ')}`, [0.13, 0.25], false],
    ['six 4-digit numbers, spaces', () => `units ${[1, 2, 3, 4, 5, 6].map(() => num(4)).join(' ')}`, [0.2, 0.34], false],
    ['eight 4-digit numbers, spaces', () => `units ${Array.from({ length: 8 }, () => num(4)).join(' ')}`, [0.32, 0.5], false],
    ['eight 4-digit numbers, commas', () => `units ${Array.from({ length: 8 }, () => num(4)).join(', ')}`, [0, 0], true],
  ];
  const lines = [];
  for (const [name, gen, [lo, hi], parity] of shapes) {
    const N = 4000;
    let masked = 0;
    let screened = 0;
    for (let i = 0; i < N; i++) {
      const s = gen();
      const changed = maskNeverStore(s) !== s;
      const flagged = holdsFinancial(s);
      if (changed) masked++;
      if (flagged) screened++;
      if (parity) assert.strictEqual(changed, flagged, `the mask and the old screen disagree on: ${s}`);
      else assert.strictEqual(changed, flagged || usualLayoutCardInside(s), `the mask is not explained by the screen or the usual-layout reading: ${s}`);
    }
    const rate = masked / N;
    assert.ok(rate >= lo && rate <= hi, `${name}: ${(100 * rate).toFixed(1)}% is outside ${100 * lo}-${100 * hi}%`);
    lines.push(`${name} ${(100 * rate).toFixed(1)}% (screen ${(100 * screened / N).toFixed(1)}%)`);
  }
  process.stdout.write(`      (measured over 4,000 random lists each, mask vs the old screen: ${lines.join('; ')})\n`);
});

// ════════════════════════════════════════════════════════════════════════
// C4. FALSE-POSITIVE CORPUS: 300 ORDINARY SYNTHETIC WORK ORDERS
// ════════════════════════════════════════════════════════════════════════
function ordinaryOrder(g) {
  const ticket = () => g.pick([`Ticket #${g.digits(6)}`, `WO ${g.digits(7)}`, `job ${g.digits(4)}`, `order ${g.digits(5)}`, `PO ${g.digits(8)}`, `ref ${g.digits(10)}`]);
  const unit = () => g.pick([`unit ${g.ri(1, 999)}`, `Apt ${g.ri(1, 40)}${g.pick(['A', 'B', 'C', ''])}`, `Unit ${g.ri(100, 999)}`, `units ${g.ri(100, 900)}, ${g.ri(100, 900)} and ${g.ri(100, 900)}`, `#${g.ri(1, 60)}${g.pick(['', 'C', 'D'])}`, `building ${g.ri(1, 30)}, space ${g.ri(1, 99)}`]);
  const phone = () => { const a = g.ri(200, 989); const b = g.ri(200, 989); const c = g.digits(4); return g.pick([`(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`, `${a} ${b} ${c}`, `${a}${b}${c}`, `+1 ${a} ${b} ${c}`]); };
  const money = () => g.pick([`$${g.ri(5, 900)}`, `$${g.ri(1, 9)},${g.digits(3)}.${g.digits(2)}`, `$${g.ri(50, 5000)}.00`, `${g.ri(40, 600)} dollars`]);
  const date = () => g.pick([`${g.ri(1, 12)}/${g.ri(1, 28)}/2026`, `2026-${String(g.ri(1, 12)).padStart(2, '0')}-${String(g.ri(1, 28)).padStart(2, '0')}`, `${g.ri(1, 12)}-${g.ri(1, 28)}-26`, `10/${g.ri(1, 28)}`, `between ${g.ri(8, 11)}-${g.ri(12, 17)}`, `at ${g.ri(1, 12)}:${String(g.ri(0, 59)).padStart(2, '0')}`]);
  const serial = () => g.pick([`serial ${g.digits(g.ri(8, 12))}`, `SN-${g.digits(4)}-${g.digits(4)}-${g.digits(4)}`, `model WH${g.ri(30, 80)}T${g.ri(10, 20)}`, `part ${g.ri(1, 9)}/${g.ri(2, 8)}-${g.ri(10, 20)} NPT`, `model ${g.pick(['GE', 'KA', 'LG', 'WP'])}${g.digits(5)}${g.pick(['X', 'B', 'RW'])}`, `tag ${g.digits(7)}`, `UPC ${g.digits(12)}`, `meter ${g.digits(4)} ${g.digits(4)} ${g.digits(4)}`]);
  const measure = () => g.pick([`${g.ri(8, 14)} x ${g.ri(8, 16)}`, `${g.ri(1, 7)}/${g.ri(2, 8)}" bolt`, `${g.ri(20, 80)} gal`, `${g.ri(5, 9)} ft ${g.ri(1, 11)} in`, `${g.ri(2, 30)} amp breaker`, `${g.ri(1, 9)}.${g.ri(1, 9)} cubic ft`, `${g.ri(10, 99)} psi`]);
  const zip = () => g.pick([`${g.pick(['92507', '92501', '90210', '91752', '92881'])}`, `${g.pick(['92507', '92501', '90210'])}-${g.digits(4)}`]);
  const code = () => g.pick([`gate code ${g.digits(4)}`, `lockbox ${g.digits(4)}`, `alarm code ${g.digits(g.ri(4, 6))}`, `garage keypad ${g.digits(4)}`, `lock code ${g.digits(4)}`]);
  const word = () => g.pick([
    'the account balance is not part of this request', 'card reader at the laundry room is broken', 'key card does not open the gate', 'tenant forgot the portal password and needs it reset',
    'routing the new pipe along the wall', 'password reset email never came', 'SWIFT response needed from the vendor', 'social media post about the leak', 'the visa expired so the tenant moves out',
    'credit card machine in the office is down', 'tenant account was credited last month', 'owner account statement attached', 'routing number is on the owner file',
  ]);
  const verb = () => g.pick(['Leak under the sink at', 'Replace the dishwasher in', 'Tenant reports no hot water in', 'Smoke detector chirping in', 'Garage door stuck at', 'Check the AC at', 'Paint touch up needed in', 'Lock change requested for', 'Clogged drain at']);
  const slots = [ticket, unit, phone, money, date, serial, measure, zip, code, word];
  const used = [];
  for (let k = 0; k < g.ri(4, 8); k++) used.push(g.pick(slots)());
  const title = `${verb()} ${unit()}`;
  // numbers are always separated by words or punctuation, so a run of digits never joins two items
  const glue = [', ', '. ', '; ', ' - ', ' and ', ', also '];
  const description = used.map((u, i) => (i ? g.pick(glue) : '') + u).join('') + '.';
  return { title, description };
}

test('C4a 300 ordinary synthetic work orders (tickets, units, phones in 5 formats, dollars, dates, serials, model and part numbers, measurements, ZIP codes, gate / lockbox / alarm codes, everyday uses of account / card / password / social / routing / swift): 0 changed by the mask', async () => {
  const g = make(20261016);
  let changed = 0;
  const bad = [];
  const kinds = { phones: 0, dollars: 0, serials: 0, codes: 0, words: 0 };
  for (let i = 0; i < 300; i++) {
    const { title, description } = ordinaryOrder(g);
    for (const t of [title, description]) {
      const cleaned = cleanText(t);
      const out = cleanTextUnscreened(t);
      if (out !== cleaned) { changed++; bad.push(`${t}  =>  ${out}`); }
      assert.strictEqual(maskNeverStore(cleaned), cleaned);
    }
    if (/\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}|\d{10}/.test(description)) kinds.phones++;
    if (/\$\d/.test(description)) kinds.dollars++;
    if (/serial|SN-|model|part /.test(description)) kinds.serials++;
    if (/gate code|lockbox|alarm code|keypad|lock code/.test(description)) kinds.codes++;
    if (/account|card|password|routing|SWIFT|social|visa/.test(description)) kinds.words++;
  }
  assert.deepStrictEqual(bad, [], `the mask changed ordinary work orders:\n${bad.join('\n')}`);
  assert.strictEqual(changed, 0);
  assert.ok(kinds.phones > 40 && kinds.dollars > 40 && kinds.serials > 40 && kinds.codes > 40 && kinds.words > 40, JSON.stringify(kinds));
  process.stdout.write(`      (300 ordinary work orders, title and description: 0 changed; coverage of the generated text: ${JSON.stringify(kinds)})\n`);
});

test('C4b the same orders (a sample of 60) through the whole screen-off summary: the printed block is the cleaned text, untouched by the mask', async () => {
  const g = make(20261016);
  const { prepareWorkOrderSummary, UNSCREENED_FOOTER } = K.summaryMod;
  const baseJob = K.baseJob;
  for (let i = 0; i < 300; i++) {
    const { title, description } = ordinaryOrder(g);
    if (i % 5 !== 0) continue; // a sample of 60 through the whole path (each goes through the async summary)
    process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN = 'off';
    const res = await prepareWorkOrderSummary(baseJob({ name: title, description }), { podUnassigned: false });
    delete process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN;
    assert.strictEqual(res.status, 'shown');
    assert.strictEqual(res.lines[res.lines.length - 1], UNSCREENED_FOOTER);
    const d = res.lines.find((l) => l.startsWith('  Description:'));
    assert.ok(!d.includes(M), `the mask changed an ordinary order: ${d}`);
  }
});

// Adversarial but ordinary: strings an operator would expect to survive. 0 may change.
const ADVERSARIAL_ORDINARY = [
  'Tenant cannot log in, the portal password for unit 5B does not work', 'password for the portal needs reset', 'The password reset link expired', 'Please send the tenant a password reset email',
  'Password: not working', 'password: expired', 'Portal password: reset requested', 'password for wifi is posted in the lobby', 'password for the lockbox is on the lease', 'the password was changed yesterday',
  'the new password was emailed to the owner', 'password reset to default', 'password reset to the original', 'forgot password, needs new password', 'password: see attached', 'Password required to open the PDF',
  'password protected file is attached', 'the password was sent to the owner by text', 'wifi password is on the router label', 'passwords are stored in AppFolio', 'password was verified by the owner', 'password for the account is unknown',
  'password for the gate remote is the same as before', 'password to the portal is not working', 'Password reset: needed', 'Password reset sent to: maria@example.com', 'Tenant password: forgot, needs reset',
  'portal password is the same as the unit number', 'password reset to tenant', 'Password: Not Working', 'Password: reset requested by Maria Lopez', 'Password reset email was sent to the tenant',
  'password reset email: maria@example.com', 'passwords are not working', 'password is incorrect', 'password manager installed', 'password expired yesterday',
  'swift plumbing came out', 'Swift Plumbing invoice', 'swift response by vendor', 'swift repairs please', 'swift code response', 'BIC lighter found', 'the SWIFT reply was fast', 'Swift Payments Inc called',
  'account 2026 10 17', 'account 2026-10-17', 'routing 10-17-26', 'account 15-03-2026', 'account 10-17-2026', 'account 31 12 1999', 'acct 06 15 26', 'account 951-555-1234', 'routing the pipe 12 feet',
  'Units 4101, 4102, 4103, 4104', 'Units 101 102 103 104 105', 'unit 4521 4522 4523 4524', 'ticket 4421-5532-6643-7754', 'serial 4482-9913-2201-7788', 'Units 1201 1202 1203 1204',
  'WO 1234567 and 7654321', 'phone 951 555 1234 ext 4455', 'Call 951-555-1234 or 951 555 1234', 'Part 3/4-14 NPT x 12, qty 6', 'invoice 20261017-0042 for $318.75', 'meter 0044 5566 7788 reading 1024',
  'gate code 2040 lockbox 1234 alarm 987654', 'ZIP 92507-1234 unit 12', 'between 9-12 on 10/17/2026', 'Rent $2,450.00 due on the 1st', 'card reader broken', 'key card 12345 does not work', 'social media post',
  'the account balance is $350.00', 'tenant account was credited', 'Owner account statement attached',
  'Tenant says the portal password for unit 7 never worked since move-in', 'password is the same as last year, tenant says', 'Do not email the password, call the tenant', 'new password link sent to the owner',
  'password: n/a', 'password: none', 'Please reset the wifi password for unit 12', 'routing 12 feet of conduit along the wall', 'account manager called about the lease', 'visa 2 weeks left',
  'bic 5 mm allen key', 'SWIFT, the new vendor, arrives at 9', 'cuenta con 3 recamaras y 2 banos',
  // round 6: the readings added for "password to X", "password will be X" and the password lists, and the one pass over an SSN and a card
  'Password reset is complete', 'password reset is complete and tenant can log in', 'password to the unit alarm is with the owner', 'password for the lockbox is held by the office', 'the password was already set',
  'password will be sent to the owner', 'password must be at least 8 characters', 'password now working', 'password set as default', 'password to portal', 'Passwords: see the office',
  'ticket 4421-5532-6643-7754 and unit 4521 4522 4523 4524', 'Tenant account password reset requested, ssn not on file', 'the visa expired, social worker called, card key replaced',
];

test('C4c adversarial probes: about 100 ordinary strings with the keyword words and number shapes the new rules touch are left exactly as typed', async () => {
  const wrong = ADVERSARIAL_ORDINARY.filter((s) => maskNeverStore(s) !== s).map((s) => `${s}  =>  ${maskNeverStore(s)}`);
  assert.deepStrictEqual(wrong, [], `the mask changed ordinary text:\n${wrong.join('\n')}`);
  assert.ok(ADVERSARIAL_ORDINARY.length >= 80);
  process.stdout.write(`      (${ADVERSARIAL_ORDINARY.length} adversarial ordinary strings, 0 changed)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// C5. PASSWORDS
// ════════════════════════════════════════════════════════════════════════
const PW_MASKED = [
  // filler words between the keyword and the value (Judge / TARS bug 4 / Sentinel S3-1)
  ['the password for the portal is hunter2', `the password for the portal is ${M}`], ['password for wifi: Summer2024', `password for wifi: ${M}`],
  ['The portal password for the tenant = Rincon2024!', `The portal password for the tenant = ${M}`], ['wifi password was reset to Temp1234 by the vendor', `wifi password was reset to ${M} by the vendor`],
  ['password changed to Summer2024!', `password changed to ${M}`], ['password reset to Temp1234', `password reset to ${M}`], ['the password for the lock is 1234', `the password for the lock is ${M}`],
  ['Wi-Fi password for the guest network is purple', `Wi-Fi password for the guest network is ${M}`], ['contraseña para el portal es Sol1234', `contraseña para el portal es ${M}`],
  ['passcode for the garage keypad: 4455', `passcode for the garage keypad: ${M}`], ['the portal password to log in is Welcome1', `the portal password to log in is ${M}`],
  ['the password for the portal was reset to Temp1234', `the password for the portal was reset to ${M}`], ['I changed the password for the lockbox at the gate to Gate2024', `I changed the password for the lockbox at the gate to ${M}`],
  // an everyday first word after a colon or equals sign, followed by more words (a passphrase)
  ['password: correct horse battery', `password: ${M}`], ['passphrase: correct horse battery staple', `passphrase: ${M}`], ['password: my dog spot', `password: ${M}`],
  ['Password = the big red barn.', `Password = ${M}.`], ['password for wifi: correct horse battery staple', `password for wifi: ${M}`], ['password: correct horse battery, thanks', `password: ${M}, thanks`],
  ['PASSWORD: Correct Horse Battery', `PASSWORD: ${M}`],
  // the original rules still hold
  ['password: Hunter22!', `password: ${M}`], ['The wifi password is Rincon2024', `The wifi password is ${M}`], ['pwd=abc123', `pwd=${M}`], ['password hunter2.', `password ${M}.`],
];

test('C5a passwords after filler words, after "reset to", and an everyday first word after a colon followed by passphrase-like words, are replaced; each to the exact expected text (TARS bug 4, Judge recommendation)', async () => {
  for (const [input, expected] of PW_MASKED) assert.strictEqual(maskNeverStore(input), expected, `input: ${input}`);
  for (const [input] of PW_MASKED) {
    const once = maskNeverStore(input);
    assert.strictEqual(maskNeverStore(once), once, `not idempotent: ${input}`);
    assert.strictEqual(cleanTextUnscreened(input), cleanTextUnscreened(cleanTextUnscreened(input)), `whole cleaning not stable: ${input}`);
  }
  process.stdout.write(`      (${PW_MASKED.length} password strings, each to the exact expected text)\n`);
});

test('C5b the new password rules do not touch everyday sentences (a status note after a colon, "reset to default", an e-mail address after "password reset sent to:")', async () => {
  const quiet = [
    'Password: Not Working', 'Password: wrong', 'Password: reset requested by Maria Lopez', 'Password: not working on portal', 'password: expired please reset',
    'password reset to the original', 'password reset to tenant', 'Password reset sent to: maria@example.com', 'the password for the portal is wrong', 'the password for the portal is expired',
    'wifi password was reset by the vendor', 'password for the unit is on the lease', 'the password was emailed', 'passwords stored in the office are listed in AppFolio',
    'password for the portal of the old unit is purple', 'password for the portal of unit is purple', 'password for the old unit at the front office to be changed: ask Maria',
  ];
  for (const s of quiet) assert.strictEqual(maskNeverStore(s), s, s);
  // the safeguards are what keep them quiet: the status-note test (a phrase of mostly everyday words) and the "secret-looking after to" test
  assert.strictEqual(maskNeverStore('Password: correct horse'), 'Password: correct horse', 'two words starting with an everyday word are a status note, not enough to call a passphrase (listed as a limit)');
});

// ════════════════════════════════════════════════════════════════════════
// C6. BARE SWIFT KEYWORD; DATE EXEMPTION AFTER account / routing IS RANGE-CHECKED
// ════════════════════════════════════════════════════════════════════════
test('C6a "SWIFT: DEUTDEFF" and "swift DEUTDEFF" are masked without the word "code" (TARS bug 3); ordinary uses of the word are not', async () => {
  for (const [input, expected] of [
    ['SWIFT: DEUTDEFF', `SWIFT: ${M}`], ['swift DEUTDEFF', `swift ${M}`], ['bic CHASUS33', `bic ${M}`], ['swift: CHASUS33XXX', `swift: ${M}`], ['SWIFT/BIC DEUTDEFF500', `SWIFT/BIC ${M}`],
    ['swift code DEUTDEFF500', `swift code ${M}`], ['BIC code: DEUTDEFF', `BIC code: ${M}`], ['wire to swift abcdef12 today', `wire to swift ${M} today`],
  ]) assert.strictEqual(maskNeverStore(input), expected, input);
  for (const s of ['swift response needed', 'swift repairs please', 'swift code response', 'Swift Plumbing invoice', 'swift plumber came', 'the SWIFT reply was fast', 'swift and quiet', 'bic pens are in the supply closet']) {
    assert.strictEqual(maskNeverStore(s), s, s);
  }
});

test('C6b a date shape after account / acct / routing / aba / rtn / cuenta is left alone only when it can be a real date; otherwise it is an account number (TARS bug 5)', async () => {
  for (const s of ['12-34-5678', '1234 56 78', '12 34 5678', '1234 05 07', '2026-13-45', '99 99 9999', '2026 00 10', '12 34 56']) {
    for (const kw of ['account', 'acct', 'routing', 'aba', 'rtn', 'cuenta']) assert.strictEqual(maskNeverStore(`${kw} ${s} ok`), `${kw} ${M} ok`, `${kw} ${s}`);
  }
  for (const s of ['2026-10-17', '2026 10 17', '10-17-2026', '10 17 2026', '15-03-2026', '31 12 1999', '06-15-26', '01-05-2026']) {
    for (const kw of ['account', 'acct', 'routing']) assert.strictEqual(maskNeverStore(`${kw} ${s} ok`), `${kw} ${s} ok`, `${kw} ${s}`);
  }
  // still true: a phone-shaped number after the word is left alone, a plain number of 6+ digits is masked
  assert.strictEqual(maskNeverStore('account 951-555-1234'), 'account 951-555-1234');
  assert.strictEqual(maskNeverStore('account 12345678'), `account ${M}`);
});

// ════════════════════════════════════════════════════════════════════════
// C7. WHAT THE MASK STILL DOES NOT CATCH (the SPEC lists the same)
// ════════════════════════════════════════════════════════════════════════
const STILL_NOT_CAUGHT = [
  ['apt 12 4111 11111 11111 11', 'a card in an UNUSUAL grouping written straight after another number (the run is read from its start, as the old screen read it; a card in the usual groupings is found there, see C1e)'],
  ['Ref 4111 1111 1111 111 done', 'a card number with a digit missing, no card word'],
  ['paid 4111.1111.1111.1111', 'a card number with dots, slashes or underscores inside, no card word'],
  ['paid 4111/1111/1111/1111', 'the same with slashes'],
  ['paid 4111 - 1111 - 1111 - 1111', 'a card number with spaced dashes between its groups, no card word (TARS bug 4; the old screen\'s pattern did not read it either)'],
  ['paid 4111, 1111, 1111, 1111', 'the same with commas'],
  ['paid (4111) (1111) (1111) (1111)', 'the same with brackets'],
  ['visa 4499451259655505 951-555-0142', 'a card word and a card number with another number straight after it: the run is longer than 19 digits, so the word rule does not read part of it (a number that passes the check digit is still found by the card rule)'],
  ['ssn: 123 - 45 - 6789', 'a Social Security number with spaced dashes (Sentinel S3-8)'],
  ['acct: 1 2 3 4 5 6 7 8 9', 'an account number typed one digit at a time'],
  ['routing: 0 2 1 0 0 0 0 2 1', 'a routing number typed one digit at a time'],
  ['swift: deutdeff', 'a SWIFT code in lowercase with no digit'],
  ['swiftcode DEUTDEFF', 'the keyword glued to the word code'],
  ['SWIFT CODE: DEUT DE FF', 'a SWIFT code written in groups'],
  ['password (temporary): Hunter22', 'brackets between the keyword and the colon'],
  ['password became Rincon2026', 'a connector word that is not is / was / are / es / to / be / as / now or a colon (TARS probe)'],
  ['password updated, it is hunter2', 'a comma between the filler word and "it is"'],
  ['password was reset.  Temp1234', 'a full stop between the filler word and the value'],
  ['the password for the old portal of the main unit is Summer2024', 'more than four filler words before "is"'],
  ['password: visa', 'a password that is itself one of the other rules\' keywords (visa, account, ssn ...): a password rule never takes those words as a value'],
  ['Mastercard ending in 4444', 'the last four digits of a card'],
  ['deposit to 123456789012 today', 'an account number with no keyword'],
  ['bank 123456789 and checking 123456789', 'a number after "bank" or "checking" (only account, acct, routing, aba, rtn, cuenta are keywords)'],
  ['a/c 123456789', 'a/c and acc as short words for account'],
  ['acct 12345', 'a bank account of fewer than six digits'],
  ['account 123-456-7890', 'an account number written like a phone number'],
  ['ssn ending 6789', 'the last four digits of a Social Security number'],
  ['Id 123456789 ok', 'nine digits with no separator and no keyword'],
  ['ssn 123.45.6789 and 123/45/6789', 'an SSN with dots or slashes'],
  ['ssn123456789', 'a keyword glued to the digits'],
  ['soc 123456789', 'a short word for social security (only ssn, social, social security, seguro social are keywords)'],
  ['password hunter', 'a plain lowercase word after "password" with no colon, equals sign or "is"'],
  ['passphrase correct horse battery staple', 'a passphrase with no colon, equals sign or "is" after the keyword'],
  ['pw: hunter2 and pass: hunter2', 'other short words for a password (pw, pass)'],
  ['Password: correct horse', 'a two-word passphrase that starts with an everyday word (a status note looks the same)'],
  ['password is correct horse battery', 'a passphrase that starts with an everyday word after "is" (the phrase reading needs a colon or equals sign)'],
  ['Password: wrong', 'a one-word value that is an everyday word'],
  [`p${String.fromCodePoint(0x430)}ssword: Hunter22`, 'a keyword written with look-alike letters (Cyrillic a)'],
  ['clave: 4455 and pin 4455', 'other words for a code (clave, pin): gate, lockbox and alarm codes pass by the owner\'s decision'],
  ['call 951-555-1234, mail john@example.com, Maria Lopez', 'phone numbers, e-mail addresses, names (owner decision)'],
  ['my number is one two three four five six seven eight nine', 'digits written as words'],
  ['41111111111111111111', 'a single run of more than 19 digits'],
  ['driver license D1234567 passport 123456789 EIN 12-3456789', 'driver licence, passport and tax numbers'],
];

test('C7 the known limits, pinned: each of these is NOT masked today (the SPEC lists the same); a change here must change the SPEC', async () => {
  for (const [input, why] of STILL_NOT_CAUGHT) {
    if (input.startsWith('apt 12 4111 11111')) assert.strictEqual(luhnOk('124111111111111111'), false, 'fixture passes the check digit by chance');
    assert.strictEqual(maskNeverStore(input), input, `now masked (update the SPEC if this is intended): ${why}`);
  }
  // the first word of an unquoted passphrase that does not start with an everyday word is masked, the rest is not (unchanged limit)
  assert.strictEqual(maskNeverStore('password: purple horse battery staple'), `password: ${M} horse battery staple`);
  assert.strictEqual(maskNeverStore('password: Blue Sky Dancing Tonight'), `password: ${M} Sky Dancing Tonight`);
  // several passwords in a row: four are taken, a fifth is not; a pure number after the list separator is not taken
  assert.strictEqual(maskNeverStore('password: a1B2c3 / d4E5f6 / g7H8i9 / j1K2l3 / m4N5o6'), `password: ${M} / m4N5o6`);
  assert.strictEqual(maskNeverStore('passwords: 1234 / 5678'), `passwords: ${M} / 5678`);

});

const NEW_KNOWN_FALSE_POSITIVES = [
  ['units 4111 1111 1111 1111', `units ${M}`, 'a list of ordinary numbers that happens to pass the check digit (about 1 in 10 lists of four 4-digit numbers, the same rate as the old screen)'],
  ['SWIFT RESPONSE NEEDED', `SWIFT ${M} NEEDED`, 'an 8 letter word in capitals right after the word swift or bic'],
  ['account 1234 05 07', `account ${M}`, 'a number after account that is shaped like a date but is not one'],
  ['password: new Maria Lopez Smith', `password: ${M}`, 'an everyday word after "password:" followed by words that are not (a name)'],
  ['password for the unit is purple', `password for the unit is ${M}`, 'any word after "password ... is" that is not on the everyday-word list'],
  ['wifi password sticker is faded', `wifi password sticker is ${M}`, 'any word after "password ... is" that is not on the everyday-word list'],
  ['Wi-Fi password - 951-555-0142', `Wi-Fi password - ${M}`, 'a phone number right after "password" and a dash'],
  ['password must be 8 characters', `password must be ${M} characters`, 'a number right after "password ... be / as / now / to" (round 6: the value after those words is masked when it has a digit)'],
  ['123-45-6789 and unit 4521 4522 4523 4524 4525', `${M} and unit 4521 4522 4523 4524 4525`, 'control: an SSN beside words is masked on its own and the unit numbers are left'],
];

test('C7b the new known false positives, pinned: these ARE masked today (rare, harmless; the SPEC lists them)', async () => {
  for (const [input, expected] of NEW_KNOWN_FALSE_POSITIVES) assert.strictEqual(maskNeverStore(input), expected, input);
});

// ════════════════════════════════════════════════════════════════════════
// C8. INVARIANTS
// ════════════════════════════════════════════════════════════════════════
test('C8a over 30,000 generated strings the mask is idempotent after the whole unscreened cleaning, never throws, never grows the text by more than the marker, and never leaves a card number', async () => {
  const g = make(918273);
  const words = ['password', 'password:', 'for', 'the', 'portal', 'is', 'was', 'to', 'reset', 'wifi', 'hunter2', 'Summer2024', 'correct', 'horse', 'battery', 'swift', 'SWIFT:', 'DEUTDEFF', 'bic', 'account', 'acct', 'routing',
    'card', 'ssn', '123-45-6789', '4111', '1111', '1234', '12', '99', '2026-10-17', '12-34-5678', '1', '-', ':', '=', '.', ',', 'unit', 'ticket', 'visa', 'tarjeta', 'cuenta', 'contraseña', 'es', '"my secret"', '[removed]'];
  let n = 0;
  for (let i = 0; i < 30000; i++) {
    const parts = Array.from({ length: g.ri(1, 14) }, () => g.pick(words));
    const s = parts.join(g.pick([' ', ' ', ' ', '-', '  ']));
    const once = cleanTextUnscreened(s);
    assert.strictEqual(cleanTextUnscreened(once), once, `not stable: ${JSON.stringify(s)}`);
    assert.strictEqual(maskNeverStore(once), once, `the printed text is not a fixed point of the mask: ${JSON.stringify(s)}`);
    n++;
  }
  assert.strictEqual(n, 30000);
});

test('C8b hostile size: 20,000 characters of the new rules\' trigger words, digit groups and separators finish well inside the time budget', async () => {
  const N = 20000;
  const shapes = {
    'password flood': 'password '.repeat(N / 9), 'password for flood': 'password for the '.repeat(N / 17), 'password word flood': ('password ' + 'abcdefghijklmn '.repeat(5)).repeat(N / 80),
    'password colon flood': 'password: correct '.repeat(N / 18), 'password then long word': `password ${'x'.repeat(N)}`, 'password colon phrase': `password: ${'my dog '.repeat(N / 7)}`,
    'swift flood': 'swift '.repeat(N / 6), 'single digits': '1 '.repeat(N / 2), 'single digits with dashes': '1-'.repeat(N / 2), 'digit groups of 4': '1234 '.repeat(N / 5),
    'digit groups of 13': '1234567890123 '.repeat(N / 14), 'digit runs of 19': '1234567890123456789 '.repeat(N / 20), 'account dates': 'account 2026-10-17 '.repeat(N / 19), 'card flood': 'card 1 '.repeat(N / 7),
  };
  let worst = 0;
  for (const [name, text] of Object.entries(shapes)) {
    const t = process.hrtime.bigint();
    maskNeverStore(text);
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    worst = Math.max(worst, ms);
    assert.ok(ms < 250, `${name}: ${ms.toFixed(0)} ms`);
  }
  process.stdout.write(`      (${Object.keys(shapes).length} hostile shapes of 20,000 characters, the slowest ${worst.toFixed(0)} ms)\n`);
});

// ════════════════════════════════════════════════════════════════════════
// C10. A SOCIAL SECURITY NUMBER BESIDE A CARD OR A LIST OF NUMBERS: ONE PASS
// ════════════════════════════════════════════════════════════════════════
/**
 * The mask only replaces spans with the marker and keeps everything else as typed, so the output can be laid over the input:
 * the ranges of `input` that are still in `output`, or null when it cannot be aligned. (A search for the secret's digits in
 * the output would be fooled by an ordinary number that happens to repeat some of them.)
 */
function keptRanges(input, output) {
  const segs = output.split(M);
  const startsMasked = segs[0] === '';
  const endsMasked = segs[segs.length - 1] === '';
  const list = segs.filter((x) => x !== '');
  const res = [];
  const go = (i, pos) => {
    if (i === list.length) return endsMasked || pos === input.length;
    let from = pos;
    for (;;) {
      const idx = input.indexOf(list[i], from);
      if (idx < 0) return false;
      if (!(i === 0 && !startsMasked && idx !== 0)) {
        res.push([idx, idx + list[i].length]);
        if (go(i + 1, idx + list[i].length)) return true;
        res.pop();
      }
      from = idx + 1;
    }
  };
  return go(0, 0) ? res : null;
}
/** Parts [text, kind] joined by single spaces; the spans of the SSN and card parts are returned for the leak test. */
function joinParts(parts, lead = '') {
  let text = lead;
  const spans = [];
  parts.forEach(([t, kind], i) => {
    if (i) text += ' ';
    if (kind !== 'other') spans.push([text.length, text.length + t.length]);
    text += t;
  });
  return { text, spans };
}
/** True when a digit inside one of the spans is still in the printed text. */
function digitLeft(text, spans) {
  const out = maskNeverStore(text);
  const kept = keptRanges(text, out);
  assert.ok(kept, `cannot lay the output over the input: ${JSON.stringify(text)} => ${JSON.stringify(out)}`);
  for (const [a, z] of spans) for (let p = a; p < z; p++) if (/\d/.test(text[p]) && kept.some(([x, y]) => p >= x && p < y)) return true;
  return false;
}

const SSN_BESIDE_FIXED = [
  // TARS bug 1: the three strings that left part of the SSN visible at c205631 (all digits are an SSN and a card)
  ['123-45-6789 4111 1111 1111 1111', M], ['6011 7139 5959 0615 865-46 8493', M], ['663-49 5210 5107 3291 7813 6481', M],
  ['4111 1111 1111 1111 123-45-6789', `${M} ${M}`], ['ssn 123-45-6789 4111 1111 1111 1111', `ssn ${M} ${M}`], ['123-45-6789, 4111 1111 1111 1111', `${M}, ${M}`],
  ['tenant gave 123 45 6789 4111-1111-1111-1111 today', `tenant gave ${M} today`], ['4111-1111-1111-1111 123 45 6789', `${M} ${M}`],
  // a list of ordinary 4-digit numbers beside an SSN: the SSN goes, the numbers stay unless they pass the check digit
  ['123-45-6789 4521 4522 4523 4524', `${M} 4521 4522 4523 4524`], ['123-45-6789 4521 4522 4523', `${M} 4521 4522 4523`], ['4521 4522 4523 4524 123-45-6789', `4521 4522 4523 4524 ${M}`],
];

test('C10a the three strings TARS found, and the named cases, to the exact text: no digit of the SSN or the card is left, in either order (TARS bug 1 / Judge fix 1 / Asimov U-2a)', async () => {
  for (const [input, expected] of SSN_BESIDE_FIXED) {
    assert.strictEqual(maskNeverStore(input), expected, input);
    assert.strictEqual(cleanTextUnscreened(input), expected, `through the whole unscreened cleaning: ${input}`);
    assert.strictEqual(maskNeverStore(expected), expected, `not stable: ${input}`);
  }
  for (const s of ['123-45-6789 4111 1111 1111 1111', '6011 7139 5959 0615 865-46 8493', '663-49 5210 5107 3291 7813 6481']) assert.ok(!/\d/.test(maskNeverStore(s)), s);
  // the six unit / ticket / serial strings stay as typed (no card-prefix rule), and a lone SSN next to a comma or a word is masked on its own
  for (const s of LOOKS_LIKE_A_CARD_BUT_IS_NOT.slice(0, 6)) assert.strictEqual(maskNeverStore(s), s, s);
  assert.strictEqual(maskNeverStore('unit 4521 4522 4523 4524, ssn 123-45-6789'), `unit 4521 4522 4523 4524, ssn ${M}`);
});

test('C10b 5,000 random cases per shape, with and without the word "ssn" or other words around: SSN then card, card then SSN, SSN then four 4-digit numbers, SSN then two or three 4-digit numbers (and four more shapes): no digit of the SSN or of the card is left', async () => {
  const g = make(20261017);
  const ssn = () => [`${g.ri(100, 899)}${g.pick([' ', '-'])}${g.ri(10, 99)}${g.pick([' ', '-'])}${g.ri(1000, 9999)}`, 'ssn'];
  const card = () => [split(g.valid(16), [4, 4, 4, 4], g.pick([' ', '-'])), 'card'];
  // minGroup: a card in an unusual grouping written after a list of ordinary numbers is a known limit (the old screen's "longest
  // window" reading takes its first small group into the list's window, and an SSN-shaped stretch inside it is masked as an SSN);
  // for that one shape every group is 4 digits or more, which is the case the stretches between SSNs are read for
  const cardAny = (minGroup = 2) => {
    const len = g.ri(13, 19);
    const sizes = [];
    for (let left = len; left > 0;) { const k = Math.min(left, g.ri(minGroup, 8)); sizes.push(k); left -= k; }
    return [split(g.valid(len), sizes, g.pick([' ', '-'])), 'card'];
  };
  const four = (k) => [Array.from({ length: k }, () => g.digits(4)).join(g.pick([' ', '-'])), 'other'];
  const num = () => [String(g.ri(1, 999)), 'other'];
  const shapes = {
    'SSN then card': [false, () => [ssn(), card()]], 'card then SSN': [false, () => [card(), ssn()]],
    'SSN then four 4-digit numbers': [true, () => [ssn(), four(4)]], 'SSN then two or three 4-digit numbers': [true, () => [ssn(), four(g.ri(2, 3))]],
    'four 4-digit numbers then SSN': [false, () => [four(4), ssn()]], 'two or three 4-digit numbers then SSN': [false, () => [four(g.ri(2, 3)), ssn()]],
    'SSN then card in any grouping': [true, () => [ssn(), cardAny()]], 'card in any grouping then SSN': [false, () => [cardAny(), ssn()]],
    'SSN, card, SSN': [true, () => [ssn(), card(), ssn()]], 'card, SSN, card': [false, () => [card(), ssn(), card()]],
    'number, SSN, card': [false, () => [num(), ssn(), card()]], 'SSN, card, number': [true, () => [ssn(), card(), num()]],
    'SSN, four 4-digit numbers, card in any grouping': [true, () => [ssn(), four(4), cardAny(4)]],
  };
  const lines = [];
  let cases = 0;
  for (const [name, [startsWithSsn, make1]] of Object.entries(shapes)) {
    let n = 0;
    for (const lead of ['', 'tenant gave ', ...(startsWithSsn ? ['ssn ', 'SSN: '] : [])]) {
      for (let i = 0; i < 5000; i++) {
        const { text, spans } = joinParts(make1(), lead);
        assert.ok(!digitLeft(text, spans), `a digit of the SSN or the card is left: ${JSON.stringify(text)} => ${JSON.stringify(maskNeverStore(text))}`);
        n++;
      }
    }
    cases += n;
    lines.push(`${name} ${n}`);
  }
  assert.ok(cases >= 5000 * 13 * 2);
  process.stdout.write(`      (0 leaks in ${cases} random cases: ${lines.join('; ')})\n`);
});

test('C10c the SSN and the card are united into one span: an SSN-shaped stretch inside a card number, and a card that starts right after or stops right before an SSN, are masked whole (the old order cut the card or the SSN)', async () => {
  const g = make(1018);
  // a card of 16 digits grouped 3-2-4-4-3 starts with an SSN-shaped stretch (C1b has 300 of them alone); here one sits beside a real SSN
  for (let i = 0; i < 2000; i++) {
    const card = split(g.valid(16), [3, 2, 4, 4, 3], g.pick([' ', '-']));
    const ssn = `${g.ri(100, 899)}-${g.ri(10, 99)}-${g.ri(1000, 9999)}`;
    for (const text of [`${ssn} ${card}`, `${card} ${ssn}`]) {
      const out = maskNeverStore(text);
      assert.ok(!/\d/.test(out), `${text} => ${out}`);
    }
  }
  assert.strictEqual(luhnOk('4111111111111111'), true);
});

// ════════════════════════════════════════════════════════════════════════
// C11. THE RULES THAT NEED A KEYWORD RUN BEFORE THE PASSWORD RULES; NO PASSWORD READING TAKES ANOTHER RULE'S KEYWORD
// ════════════════════════════════════════════════════════════════════════
test('C11a "Password reset: tenant account number 123456789012" and "Portal password: the tenant social security number 123456789" (Judge fix 2 / Sentinel S3-7 / Asimov U-2b): the keyword stays, the number goes; and the older shapes "password: account 123456789012", "password: ssn 123456789"', async () => {
  for (const [input, expected] of [
    ['Password reset: tenant account number 123456789012', `Password reset: tenant account number ${M}`],
    ['Portal password: the tenant social security number 123456789', `Portal password: the tenant social security number ${M}`],
    ['password issue: the bank account number is 123456789012', `password issue: the bank account number is ${M}`],
    ['Password reset: tenant account number is 123456789012', `Password reset: tenant account number is ${M}`],
    ['password: account 123456789012', `password: account ${M}`], ['password: ssn 123456789', `password: ssn ${M}`], ['password: social 123-45-6789', `password: social ${M}`],
    ['password is account 123456789012', `password is account ${M}`], ['password for wifi: account 123456789012', `password for wifi: account ${M}`],
    ['password reset to ssn 123456789', `password reset to ssn ${M}`], ['pwd=card 4111111111111111', `pwd=card ${M}`],
    ['password: acct 123456789012 and ssn 123456789', `password: acct ${M} and ssn ${M}`],
    ['SWIFT PASSWORD: hunter2', `SWIFT PASSWORD: ${M}`], ['BIC PASSWORD = Summer2024', `BIC PASSWORD = ${M}`],
    // a second password word inside the phrase is read on its own, and is not swallowed
    ['Wifi password: the router password: Welcome1', `Wifi password: the router password: ${M}`],
    ['Wifi password: the router password: correct horse battery', `Wifi password: the router password: ${M}`],
    ['Wifi password: the router pass code: Welcome1', `Wifi password: the router pass code: ${M}`],
    // the IBAN rule runs after the password rules: its value runs on over the next words
    ['password: iban DE89370400440532013000', `password: iban ${M}`], ['the password for the portal is iban DE89370400440532013000', `the password for the portal is iban ${M}`],
    ['password reset to iban DE89370400440532013000', `password reset to iban ${M}`], ['password: the router iban DE89370400440532013000', `password: the router iban ${M}`],
    // the IBAN value runs on over the next words but never over a second "iban" (found by a 180,000-text differential against 33c08a3)
    ['iban DE89370400440532013000 and iban DE89370400440532013001', `iban ${M} iban ${M}`],
    ['951-555-0142 and Passcode: iban number DE89370400440532013000 router iban GB82WEST12345698765432', `951-555-0142 and Passcode: iban number ${M} iban ${M}`],
  ]) {
    assert.strictEqual(maskNeverStore(input), expected, input);
    assert.strictEqual(cleanTextUnscreened(input), expected, `through the whole unscreened cleaning: ${input}`);
  }
  // an IBAN followed by a password: both go (the IBAN value may run on over the word "password", which is harmless here)
  const both = maskNeverStore('iban DE89370400440532013000 password: Hunter22');
  assert.ok(!both.includes('DE89') && !both.includes('Hunter22'), both);
});

test('C11b 12 keywords behind lead-ins like "Password reset:", "Portal password:", "password:", "wifi password for the unit:" with "please verify" / "the tenant" / "send the" and the like: 0 leaks in 600 each, and 13 more keywords and the shapes the older tests missed', async () => {
  const g = make(5150);
  const lead = ['Password reset:', 'Portal password:', 'Tenant forgot password:', 'Password issue:', 'wifi password for the unit:', 'password:', 'Password problem =', 'Password reset requested:', 'Password issue -', 'Passcode:', 'pwd:', 'Password for the portal:', 'Contrasena:'];
  const mid = ['please verify', 'tenant needs the', 'verify the', 'the tenant', 'send the', 'use the', 'see the', 'confirm', 'owner provided', '', 'the owner gave'];
  const items = [
    ['account number', () => g.digits(12)], ['bank account number', () => g.digits(10)], ['acct', () => g.digits(10)], ['account', () => g.digits(9)], ['routing number', () => `0${g.digits(8)}`],
    ['social security number', () => g.digits(9)], ['ssn', () => g.digits(9)], ['card number', () => `4${g.digits(15)}`], ['visa', () => `4${g.digits(15)}`], ['cvv', () => g.digits(3)],
    ['iban', () => g.pick(['GB82WEST12345698765432', 'DE89370400440532013000'])], ['swift code', () => 'DEUTDEFF500'],
    ['social', () => `${g.digits(3)}-${g.digits(2)}-${g.digits(4)}`], ['aba', () => g.digits(9)], ['rtn', () => g.digits(9)], ['cuenta', () => g.digits(10)], ['mastercard', () => `5${g.digits(15)}`],
    ['amex', () => `37${g.digits(13)}`], ['cvc', () => g.digits(3)], ['csc', () => g.digits(4)], ['bic', () => 'CHASUS33'], ['seguro social', () => g.digits(9)], ['tarjeta', () => `4${g.digits(15)}`],
    ['discover', () => `6011${g.digits(12)}`], ['credit card', () => `4${g.digits(15)}`],
  ];
  const lines = [];
  for (const [kw, gen] of items) {
    let leaks = 0;
    for (let i = 0; i < 600; i++) {
      const v = gen();
      const text = `${g.pick(lead)} ${g.pick(mid)} ${kw} ${g.pick(['', 'is ', ': ', '# ', 'number '])}${v}`.replace(/  +/g, ' ');
      const out = maskNeverStore(text);
      const d = v.replace(/\D/g, '');
      if (out.includes(v) || (d.length >= 6 && out.includes(d.slice(0, 6))) || (/^[A-Z]{4}/.test(v) && out.includes(v.slice(0, 6)))) { leaks++; assert.fail(`leak: ${text} => ${out}`); }
    }
    lines.push(`${kw} ${leaks}/600`);
  }
  process.stdout.write(`      (leaks per keyword, 600 texts each: ${lines.join('; ')})\n`);
});

test('C11c a password phrase before a TWO-word keyword (american express, credit card, debit card, master card, ss #, soc sec, seguro social) does not leave the number: the rules that need a keyword run first (this is what the order is for; the single-word keywords are also guarded in the readings)', async () => {
  for (const kw of ['american express', 'credit card', 'debit card', 'master card', 'ss #', 'soc sec', 'seguro social', 'social sec', 'social security', 'cuenta', 'tarjeta']) {
    const number = /card|express|tarjeta/.test(kw) ? '4111111111111111' : '123456789';
    for (const lead of ['password:', 'Portal password:', 'password for wifi is', 'the password for the portal is', 'password reset to']) {
      const text = `${lead} ${kw} ${number}`;
      const out = maskNeverStore(text);
      assert.ok(!out.includes(number.slice(0, 6)) && !out.includes(number.slice(-6)), `leak: ${text} => ${out}`);
    }
  }
});

test('C11d the order is pinned: with the IBAN rule before the password rules the password after an IBAN would be left (its value swallows the word "password")', async () => {
  const out = maskNeverStore('wifi: iban DE89370400440532013000 password Hunter22 and more');
  assert.ok(!out.includes('Hunter22') && !out.includes('DE89'), out);
  const out2 = maskNeverStore('iban DE89370400440532013000 password: Hunter22');
  assert.ok(!out2.includes('Hunter22'), out2);
});

// ════════════════════════════════════════════════════════════════════════
// C12. "password to X", several passwords in a row, "complete"
// ════════════════════════════════════════════════════════════════════════
test('C12a a password straight after "to", "now", "be" or "as" (no filler word) is masked when the value looks like a secret (TARS bug 2 / Judge / Asimov R5-3)', async () => {
  for (const [input, expected] of [
    ['Changed the password to Rincon2026', `Changed the password to ${M}`], ['we set the password to Rincon2026', `we set the password to ${M}`],
    ['password now Rincon2026', `password now ${M}`], ['password will be Welcome1', `password will be ${M}`], ['new password will be Welcome1', `new password will be ${M}`],
    ['password set as Temp1234', `password set as ${M}`], ['password should be Summer2024', `password should be ${M}`], ['the password to the portal is Hunter22!', `the password to the portal is ${M}`],
    ['password updated to Rincon2026', `password updated to ${M}`], ['password is changed to Summer2024', `password is changed to ${M}`], ['password has been changed to Summer2024', `password has been changed to ${M}`],
  ]) {
    assert.strictEqual(maskNeverStore(input), expected, input);
    assert.strictEqual(maskNeverStore(expected), expected, `not stable: ${input}`);
  }
});

test('C12b the same words with an everyday value are left alone, and "Password reset is complete" is not blanked ("complete" is an everyday word now)', async () => {
  for (const s of [
    'Password reset is complete', 'password reset is complete and tenant can log in', 'password to the unit alarm is with the owner', 'password for the lockbox is held by the office', 'the password was already set',
    'password will be sent to the owner', 'password must be at least 8 characters', 'password to portal', 'password now working', 'password now fine', 'password set as default', 'password reset to default', 'password to the portal is not working',
  ]) assert.strictEqual(maskNeverStore(s), s, s);
});

test('C12c several passwords in a row: up to four values joined by "/", a comma, "and", "or" and the like are masked together; a plain word, a pure number, an e-mail address or a fifth value after them is not taken', async () => {
  for (const [input, expected] of [
    ['Passwords: Maria1990 / Pedro1991', `Passwords: ${M}`], ['Passwords: Maria1990, Pedro1991', `Passwords: ${M}`], ['Passwords: Maria1990 | Pedro1991 & Ana2020', `Passwords: ${M}`],
    ['passwords are Maria1990 and Pedro1991', `passwords are ${M}`], ['the passwords for the portal are Maria1990 and Pedro1991', `the passwords for the portal are ${M}`],
    ['password: a1B2c3 / d4E5f6 / g7H8i9 / j1K2l3', `password: ${M}`], ['password: a1B2c3 / d4E5f6 / g7H8i9 / j1K2l3 / m4N5o6', `password: ${M} / m4N5o6`],
    ['contrasenas: Sol1234 y Luna5678', `contrasenas: ${M}`], ['Passwords: Maria1990 / Pedro1991, thanks', `Passwords: ${M}, thanks`],
    // not taken
    ['Password: Hunter22, call Maria', `Password: ${M}, call Maria`], ['password: Hunter22 / unit 5B', `password: ${M} / unit 5B`], ['password: Hunter22 or call the office', `password: ${M} or call the office`],
    ['Password: Hunter22, 951-555-0142', `Password: ${M}, 951-555-0142`], ['password: Abc123 or 555-1234', `password: ${M} or 555-1234`], ['password: Hunter22, maria@example.com', `password: ${M}, maria@example.com`],
    ['password: Hunter22. Pedro1991 is the tenant', `password: ${M}. Pedro1991 is the tenant`],
  ]) {
    assert.strictEqual(maskNeverStore(input), expected, input);
    assert.strictEqual(maskNeverStore(expected), expected, `not stable: ${input}`);
  }
});

// ════════════════════════════════════════════════════════════════════════
// C9. THE DOCUMENTS SAY WHAT THE CODE DOES
// ════════════════════════════════════════════════════════════════════════
test('C9 the SPEC describes the card rule (any grouping, the screen\'s test), says there is no card-prefix rule, gives the measured rates, lists the new limits and false positives, and shows the final last line', async () => {
  const spec = readDoc('projects/hub/work-order-notes-alert-SPEC.md');
  const { UNSCREENED_FOOTER } = K.summaryMod;
  assert.ok(spec.includes(UNSCREENED_FOOTER.trim()), 'the SPEC sample email shows the final last line');
  assert.ok(!spec.includes('links, cards, bank, SSN and passwords removed'), 'the old overclaiming last line is gone from the SPEC');
  assert.ok(spec.includes('any grouping'), 'the SPEC says cards are found in any grouping');
  assert.ok(/no card-prefix rule|not masked just because (?:it|they) look/i.test(spec), 'the SPEC says unit numbers are not masked because of how they start');
  assert.ok(spec.includes('mask-tests.js'), 'the SPEC points at the mask tests');
  for (const needle of ['1 in 10', 'SWIFT RESPONSE', 'password: correct horse', 'apt 12 4111 11111', 'pw', 'real date', 'some links, cards, SSNs, passwords removed', '730', '101 characters']) {
    assert.ok(spec.includes(needle), `the SPEC does not mention: ${needle}`);
  }
  const env = readDoc('.env.example');
  assert.ok(/best effort/.test(env.slice(env.indexOf('WORK_ORDER_ALERT_DESCRIPTION_SCREEN'))), 'the env example says the mask is best effort, not a guarantee');
});

test('C9b round 6: the SPEC gives the new mask order and the one-pass rule, no longer says the card rule runs before the SSN rule, and lists the limits the testers found (fixed ones are out of the list)', async () => {
  const spec = readDoc('projects/hub/work-order-notes-alert-SPEC.md');
  assert.ok(spec.includes('Social Security by word, account, card by word, security code, SWIFT, passwords, IBAN, then one pass for the separated Social Security number and the card number'), 'the SPEC states the new order');
  assert.ok(spec.includes('ONE pass') && spec.includes('mask-tests.js` C10'), 'the SPEC states the one-pass rule and where it is tested');
  assert.ok(spec.includes('C11'), 'the SPEC points at the order tests');
  for (const old of ['the card rule runs before the SSN rule', 'passwords, Social Security by word, account, card by word, security code, IBAN, SWIFT, card number, separated SSN', 'a bare Social Security number (no `ssn` or `social` in front) written directly beside', 'Open at `c205631`']) {
    assert.ok(!spec.includes(old), `the SPEC still says: ${old}`);
  }
  // every limit a round-5 tester listed that is not fixed is in the SPEC (TARS bugs 2 to 4, Sentinel S3-8)
  for (const needle of ['4111 - 1111 - 1111 - 1111', '(4111) (1111) (1111) (1111)', 'straight after or straight before another number', 'visa 4499451259655505', 'ssn: 123 - 45 - 6789', 'acct: 1 2 3 4 5 6 7 8 9',
    'swift: deutdeff', 'SWIFT CODE: DEUT DE FF', 'swiftcode DEUTDEFF', 'password (temporary): Hunter22', 'password became Rincon2026', 'password updated, it is hunter2', 'password was reset.  Temp1234', 'more than four filler words',
    'Blue Sky Dancing Tonight', 'more than four passwords in a row', 'password: visa', 'wifi password sticker is faded', 'Wi-Fi password - 951-555-1234', 'password must be 8 characters',
    'about 18% for five', '53% for ten', 'Luhn', 'check digit']) {
    assert.ok(spec.includes(needle), `the SPEC does not list: ${needle}`);
  }
  // the fixed items are described as fixed, with their examples
  for (const needle of ['Changed the password to Rincon2026', 'Passwords: Maria1990 / Pedro1991', 'Password reset: tenant account number 123456789012', 'Password reset is complete', '123-45-6789 4111 1111 1111 1111']) {
    assert.ok(spec.includes(needle), `the SPEC does not mention the fixed case: ${needle}`);
  }
  assert.ok(spec.includes('103 adversarial ordinary strings'), 'the SPEC count of adversarial strings is the test count');
});

runner.run();
