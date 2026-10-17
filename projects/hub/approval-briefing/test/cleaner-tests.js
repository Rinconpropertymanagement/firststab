#!/usr/bin/env node
/**
 * test/cleaner-tests.js
 * Tests for lib/work-order-text-clean.js: HTML, entities, whitespace, invisible
 * characters (every class), links (the denylist, bare domains, shorteners, IP
 * hosts, and what must be left alone), the fixed-point guarantees (idempotent,
 * never matches its own link detector, no CR/LF/invisible), 10,000+ generated
 * strings, and the time limit on 20,000-character hostile input.
 *
 * Run alone:  node projects/hub/approval-briefing/test/cleaner-tests.js
 */

const K = require('./test-kit');
const { H, assert, path, rng } = K;
const cleanMod = H.load('lib/work-order-text-clean.js');
const screenMod = H.load('lib/work-order-text-screen.js');
const { cleanText, containsLink, LINK_TEXT, CleanError } = cleanMod;

const runner = K.makeRunner('Work Order Alert cleaner tests');
const { test } = runner;
const cp = (...codes) => String.fromCodePoint(...codes);

// ════════════════════════════════════════════════════════════════════════
test('C1 HTML: tags stripped, script/style dropped with contents, br/p/div become spaces, comments dropped', async () => {
  assert.strictEqual(cleanText('<b>Bold</b> text'), 'Bold text');
  assert.strictEqual(cleanText('line one<br>line two</p>three</div>four'), 'line one line two three four');
  assert.strictEqual(cleanText('before<script>alert(1)</script>after'), 'before after');
  assert.strictEqual(cleanText('a<SCRIPT type="x">bad()</SCRIPT >b'), 'a b');
  assert.strictEqual(cleanText('a<style>.x{color:red}</style>b'), 'a b');
  assert.strictEqual(cleanText('visible<script>never closed alert(1)'), 'visible');
  assert.strictEqual(cleanText('keep<!-- hidden comment -->this'), 'keep this');
  assert.strictEqual(cleanText('<ul><li>one</li><li>two</li></ul>'), 'one two');
  assert.strictEqual(cleanText('temp < 60 and > 80'), 'temp < 60 and > 80', 'a bare < is not a tag');
  assert.strictEqual(cleanText('<<b>b>'), '', 'a tag assembled from the pieces of another is removed too');
  assert.strictEqual(cleanText(`<scr${cp(0x200B)}ipt>alert(1)</script>ok`), 'ok', 'an invisible character cannot hide a script tag');
});

test('C2 entities: the six listed ones are decoded; markup that appears only after decoding is removed; the result is stable', async () => {
  assert.strictEqual(cleanText('Tom &amp; Jerry &lt;3 &quot;x&quot; &#39;y&#39; a&nbsp;b'), 'Tom & Jerry <3 "x" \'y\' a b');
  assert.strictEqual(cleanText('&lt;script&gt;alert(1)&lt;/script&gt;x'), 'x', 'encoded script is dropped in the same pass');
  assert.strictEqual(cleanText('&lt;b&gt;hi&lt;/b&gt;'), 'hi');
  assert.strictEqual(cleanText('&amp;lt;b&amp;gt;hi'), 'hi', 'double encoding settles within the pass limit');
  assert.strictEqual(cleanText('&#x41; &copy; &euro;'), '&#x41; &copy; &euro;', 'unlisted entities are left alone');
  assert.strictEqual(cleanText('1 &lt; 2 and 3 &gt; 2'), '1 < 2 and 3 > 2');
  // ordinary double- and triple-escaped text (pasted from a web page) settles; four levels still do
  assert.strictEqual(cleanText('&amp;amp;lt;b&amp;amp;gt;'), '');
  assert.strictEqual(cleanText('Faucet drips. &amp;amp;amp;amp;lt;b&amp;amp;amp;amp;gt; thanks'), 'Faucet drips. thanks');
  assert.strictEqual(cleanText('Tom &amp;amp;amp; Jerry'), 'Tom & Jerry');
  // deliberately deep nesting will not settle: an error with a constant code, so the caller holds under its own cause
  const deep = (n, tail) => `&${'amp;'.repeat(n)}${tail}`;
  for (const n of [5, 6, 8, 40]) {
    assert.throws(() => cleanText(`${deep(n, 'lt;b')}x${deep(n, 'gt;')}`), (e) => e instanceof CleanError && e.message === 'clean_did_not_settle', `${n} levels deep: an error, so the caller holds`);
  }
});

test('C3 whitespace: newlines, CRLF, tabs and odd spaces collapse to single spaces', async () => {
  assert.strictEqual(cleanText('a\r\nb\tc\n\nd'), 'a b c d');
  assert.strictEqual(cleanText('  \u{A0}x\u{2003}\u{3000}y\u{2028}z\u{2029}w  '), 'x y z w');
  assert.strictEqual(cleanText('one\u000Btwo\u000Cthree\u0085four'), 'one two three four');
  assert.strictEqual(cleanText('   \n\t  '), '');
});

test('C4 INVISIBLE characters are REMOVED (not spaced), for every class named in the ruling, inside a keyword, and around links', async () => {
  const classes = {
    'zero width space/non-joiner/joiner, marks': [0x200B, 0x200C, 0x200D, 0x200E, 0x200F],
    'bidi embeddings and overrides': [0x202A, 0x202B, 0x202C, 0x202D, 0x202E],
    'bidi isolates': [0x2066, 0x2067, 0x2068, 0x2069],
    'word joiner and invisible math (2060-2064)': [0x2060, 0x2061, 0x2062, 0x2063, 0x2064],
    '2065 and 206A-206F': [0x2065, 0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F],
    'BOM, soft hyphen, combining grapheme joiner, Arabic letter mark': [0xFEFF, 0xAD, 0x34F, 0x61C],
    'Mongolian 180B-180F': [0x180B, 0x180C, 0x180D, 0x180E, 0x180F],
    'variation selectors FE00-FE0F': Array.from({ length: 16 }, (_x, i) => 0xFE00 + i),
    'variation selectors supplement E0100-E01EF (first, last, some middle)': [0xE0100, 0xE0101, 0xE0120, 0xE0170, 0xE01EE, 0xE01EF],
    'tag characters E0000-E007F': [0xE0000, 0xE0001, 0xE0020, 0xE0041, 0xE007F],
    'Hangul fillers': [0x115F, 0x1160, 0x3164, 0xFFA0],
    'Braille blank and object replacement': [0x2800, 0xFFFC],
    'Khmer inherent vowels': [0x17B4, 0x17B5],
    'C0 controls': [0x00, 0x01, 0x07, 0x08, 0x0E, 0x1B, 0x1F, 0x7F],
    'C1 controls': [0x80, 0x90, 0x9F],
    'private use': [0xE000, 0xF8FF, 0xF0000, 0x10FFFD],
    'interlinear annotation, shorthand format controls': [0xFFF9, 0xFFFA, 0xFFFB, 0x1BCA0, 0x1D173],
  };
  let n = 0;
  for (const [name, codes] of Object.entries(classes)) {
    for (const c of codes) {
      const ch = cp(c);
      const label = `${name}: U+${c.toString(16).toUpperCase()}`;
      assert.strictEqual(cleanText(`ab${ch}cd`), 'abcd', `${label} must be removed, not replaced by a space`);
      assert.strictEqual(cleanText(`preg${ch}nant tenant`), 'pregnant tenant', `${label} inside a keyword`);
      assert.strictEqual(cleanText(`${ch}http://x.test/a`), LINK_TEXT, `${label} before a link`);
      assert.strictEqual(cleanText(`http://x.test/a${ch}`), LINK_TEXT, `${label} after a link`);
      assert.strictEqual(cleanText(`h${ch}ttp://evil.test/a`), LINK_TEXT, `${label} inside a link scheme`);
      assert.strictEqual(cleanText(`evil${ch}.com`), LINK_TEXT, `${label} inside a bare domain`);
      n++;
    }
  }
  // lone surrogates
  assert.strictEqual(cleanText(`ab${String.fromCharCode(0xD800)}cd`), 'abcd');
  assert.strictEqual(cleanText(`ab${String.fromCharCode(0xDFFF)}cd`), 'abcd');
  // and the screen sees the joined word
  for (const c of [0x200B, 0xFE0F, 0x3164, 0xE0100]) assert.strictEqual(screenMod.screenWorkOrderText({ title: '', description: cleanText(`preg${cp(c)}nant`) }).status, 'held');
  process.stdout.write(`      (${n} invisible characters checked in 6 positions each)\n`);
});

test('C4b EVERY code point of the invisible classes is removed (full sweep over Unicode)', async () => {
  const isInvisible = /^[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\u{2800}\u{FFFC}]$/u;
  const isUnassigned = /^\p{Cn}$/u;
  let checked = 0;
  for (let c = 0; c <= 0x10FFFF; c++) {
    if (c >= 0xD800 && c <= 0xDFFF) continue;                       // surrogates: tested separately
    const ch = String.fromCodePoint(c);
    if (!isInvisible.test(ch)) continue;
    if (c === 0x09 || c === 0x0A || c === 0x0B || c === 0x0C || c === 0x0D || c === 0x85) continue; // line breaks become a space
    // Private use areas and the ~800,000 unassigned code points are huge; test every 64th (every 997th unassigned) plus the edges.
    if (((c >= 0xE000 && c <= 0xF8FF) || (c >= 0xF0000 && c <= 0x10FFFF)) && c % 64 !== 0 && c !== 0xF8FF && c !== 0x10FFFD && !isUnassigned.test(ch)) continue;
    if (isUnassigned.test(ch) && c % 997 !== 0 && c !== 0xFFFE && c !== 0xFFFF && c !== 0x378 && c !== 0x10FFFF && c !== 0x1FFFF) continue;
    // NFKC can turn a character into other characters first; none of these are visible letters.
    const out = cleanText(`ab${ch}cd`);
    assert.strictEqual(out, 'abcd', `U+${c.toString(16).toUpperCase()} survived or changed the text: ${JSON.stringify(out)}`);
    checked++;
  }
  assert.ok(checked > 1500, `only ${checked} code points swept`);
  process.stdout.write(`      (${checked} code points swept)\n`);
});

test('C4c ZWJ note: removing U+200D splits an emoji sequence into separate emoji (accepted and documented)', async () => {
  const family = cp(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);
  assert.strictEqual(cleanText(family), cp(0x1F468, 0x1F469, 0x1F467));
  const src = require('fs').readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-clean.js'), 'utf8');
  assert.ok(/ZWJ/.test(src) && /splits emoji/i.test(src), 'the code comment says so');
});

test('C5 LINKS: everything on the ruling\'s list is replaced', async () => {
  const links = [
    'evil.test/login', 'bit.ly/3abcXY', 'mailto:bob@evil.test', 'javascript:alert(1)', 'data:text/html;base64,AAAA',
    '//evil.test/a', 'evil.com', '192.168.1.1/admin',
    'http://evil.example/a?b=1', 'HTTPS://Evil.Example', 'https://evil.example:8443/x#frag', 'ftp://files.example/x', 'ftps://a.test', 'sftp://a.test/b',
    'file:///etc/passwd', 'tel:+15550100', 'sms:5550100', 'vbscript:msgbox(1)', 'blob:https://x.test/uuid', 'ws://a.test', 'wss://a.test/socket',
    'ssh://root@a.test', 'smb://server/share', 'intent://scan/#Intent;scheme=zxing;end',
    'www.evil.example/page', 'WWW.EVIL.EXAMPLE', 'www2.evil.example',
    'evil.test:8080', 'evil.test?x=1', 'evil.test#top', 'sub.evil.test/path', 'a.b.c.evil.test/x',
    'xn--abc-def.test', 'evil.xn--p1ai', 'bit.ly', 't.co/abc', 'goo.gl/x', 'tinyurl.com/y', 'ow.ly/z', 'is.gd/1', 'buff.ly/2', 'rb.gy/3', 'cutt.ly/4', 'shorturl.at/5',
    'wa.me/15550100', 't.me/handle', 'youtu.be/abc', 'lnkd.in/x', 'amzn.to/x',
    'youtu.be', 'lnkd.in', 'amzn.to', 'bit.do', 'v.gd', 's.id', 'soo.gd', 'j.mp', 'u.to', 'ift.tt', 'dlvr.it', 'lin.ee', 'wp.me', 'qr.ae', 'fb.me',
    '10.0.0.1', '10.0.0.1:8080', '255.255.255.255/x', '[::1]', '[::1]:80/x', '[2001:db8::1]/path', '2001:db8::1', 'fe80::1',
    'Evil.Co', 'evil.xyz', 'evil.top', 'evil.club', 'evil.ru', 'evil.cn', 'evil.tk', 'evil.zip', 'evil.click', 'evil.live', 'evil.icu', 'evil.vip', 'evil.work', 'evil.shop', 'evil.online',
    'evil。com', 'ｅｖｉｌ．com/ｘ',
  ];
  for (const l of links) assert.strictEqual(cleanText(`see ${l} now`), `see ${LINK_TEXT} now`, `not removed: ${l}`);
  assert.ok(cleanMod.TLDS.size >= 40, 'at least 40 abuse-prone top-level domains');
  assert.ok(['bit.ly', 't.co', 'goo.gl', 'tinyurl.com', 'ow.ly', 'is.gd', 'buff.ly', 'rb.gy', 'cutt.ly', 'shorturl.at', 'wa.me', 't.me', 'youtu.be'].every((h) => cleanMod.SHORTENERS.has(h)));
  // each scheme in the denylist
  for (const sch of ['http', 'https', 'ftp', 'ftps', 'sftp', 'file', 'mailto', 'tel', 'sms', 'javascript', 'data', 'vbscript', 'blob', 'ws', 'wss', 'ssh', 'smb', 'intent']) {
    assert.strictEqual(cleanText(`x ${sch}:abc/def y`), `x ${LINK_TEXT} y`, `scheme ${sch}`);
  }
});

test('C6 LINKS: what must be left alone is left alone (plain e-mail, phone numbers, times, dates, labels, abbreviations)', async () => {
  const keep = [
    'john.smith@example.com', 'call john@example.com now', 'first.last@sub.example.co.uk', 'bob.com@example.com', 'a_b-c.d@e-f.org',
    'mail sam@example.test.', '555-123-4567', '(805) 555-1234', '805.555.1234', '1.800.555.1212', '1-800-GOT-JUNK', '1.800.FLOWERS',
    '10:30', 'at 10:30:15 sharp', '2026-10-16', '10/16/2026', '10.16.2026', '9.00-5.00', 'Mon.-Fri. 9am',
    'Note:call', 'Time:10:30', 'Tel: 555-0100', 'Data: 5 items', 'File: A12', 'Note:', 'e.g. this', 'i.e. that', 'approx.2 more', 'No.5/6', 'v2.1/foo', '1.5/2 inch', '3.5in',
    'sink.leak is bad', 'leak.in the ceiling', 'p.m. and a.m.', 'U.S.A. made', 'Ave.Apt 5', 'unit 5B', 'gate code 2040', 'lockbox 1234', 'and/or', 'w/o power', 'N/A', 'c/o owner',
    '4.5 and 3.75', 'ft.lbs torque', 'Dr. Smith', 'St. John',
  ];
  for (const k of keep) assert.strictEqual(cleanText(k), k, `mangled: ${k}`);
});

test('C7 INVARIANTS on the ruling\'s own examples: idempotent, no link left, no CR/LF/invisible', async () => {
  const samples = ['evil.test/login', 'bit.ly/3abcXY', 'mailto:bob@evil.test', 'javascript:alert(1)', 'data:text/html;base64,AAAA', '//evil.test/a', 'evil.com', '192.168.1.1/admin',
    'john.smith@example.com', '<<b>b>', '&amp;lt;', `h${cp(0x200B)}ttp://evil.test`, 'a\nb\r\nc', 'x.coz.co.co', 'www.www.www.evil.com', 'http://http://evil.test'];
  for (const s of samples) {
    let out;
    try { out = cleanText(s); } catch (e) { assert.ok(e instanceof CleanError); continue; }
    assert.strictEqual(cleanText(out), out, `not idempotent for ${s}`);
    assert.strictEqual(containsLink(out), false, `output still matches the link detector for ${s}`);
    assert.ok(!/[\r\n]/.test(out) && !cleanMod.INVISIBLE_TEST.test(out));
  }
});

test('C8 GENERATED INPUT: 12,000 mixed strings (invisibles, entities, tags, links, newlines) all satisfy every invariant', async () => {
  const rand = rng(20261016);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const words = ['water', 'leak', 'Sink', 'tenant', 'Unit', '5B', 'call', 'drain', 'preg', 'nant', 'wheel', 'chair', 'café', 'niño', '你好', 'a', '1', '.', ',', '-', ':', '/', '@', '$'];
  const invisibles = [0x200B, 0x200C, 0x200D, 0xFE0F, 0xFE00, 0xE0100, 0xE0041, 0x3164, 0x115F, 0x00AD, 0x202E, 0x2060, 0xFEFF, 0x0000, 0x0007, 0x2800, 0xFFFC, 0xE000].map((c) => cp(c));
  const entities = ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;', '&nbsp;', '&amp;lt;', '&amp;amp;', '&unknown;'];
  const tags = ['<b>', '</b>', '<br>', '<p>', '</div>', '<script>x()</script>', '<style>a{}</style>', '<!-- c -->', '<a href="x">', '</a>', '<<b>b>', '<', '>', '<img src=x>'];
  const links = ['http://evil.test/a', 'bit.ly/x', 'www.evil.test', 'evil.com', '192.168.0.1/a', 'mailto:a@b.test', 'javascript:alert(1)', '//evil.test/x', 'data:text/html,AA', '[::1]:80',
    'xn--abc.test', 'john.smith@example.com', '555-123-4567', 'e.g.', 'approx.2', 'Note:call', 'a.co', 'x.coz.co', 'http:', 'www.', '..', 'a..b.com', '-.com', 'EVIL.COM/A'];
  const breaks = ['\n', '\r\n', '\t', ' ', '\u{2028}', '\u{A0}', '  '];
  const pools = [words, invisibles, entities, tags, links, breaks];
  let total = 0; let errors = 0; let withLink = 0;
  for (let i = 0; i < 12000; i++) {
    const parts = [];
    const n = 1 + Math.floor(rand() * 14);
    for (let j = 0; j < n; j++) {
      parts.push(pick(pick(pools)));
      if (rand() < 0.5) parts.push(pick(breaks));
    }
    const input = parts.join(rand() < 0.3 ? '' : ' ');
    let out;
    try { out = cleanText(input); } catch (e) {
      assert.ok(e instanceof CleanError, `unexpected error type for generated input #${i}`);
      assert.ok(!e.message.includes(input.slice(0, 8)) || input.length < 4, 'error messages are constant');
      errors++; continue;
    }
    total++;
    assert.strictEqual(cleanText(out), out, `not idempotent (#${i}): ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    assert.strictEqual(containsLink(out), false, `output matches its own link detector (#${i}): ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    assert.ok(!/[\r\n]/.test(out), `CR/LF in output (#${i})`);
    assert.ok(!cleanMod.INVISIBLE_TEST.test(out), `invisible character in output (#${i})`);
    assert.ok(out === out.trim() && !/\s{2,}/.test(out), `whitespace not collapsed (#${i})`);
    assert.ok(out.length <= 20000);
    if (out.includes(LINK_TEXT)) withLink++;
  }
  assert.ok(total + errors === 12000 && total >= 10000, `only ${total} strings completed (${errors} settled as errors)`);
  assert.ok(withLink > 500, 'the generator really produced links');
  process.stdout.write(`      (${total} strings satisfied every invariant, ${errors} too tangled to settle and failed closed, ${withLink} contained links)\n`);
});

test('C9 a non-text value is an error with a constant message; null/undefined are empty; errors never carry the input', async () => {
  for (const bad of [42, true, {}, [], ['x'], 3.14, NaN, () => 'x', Symbol('s'), 10n]) {
    assert.throws(() => cleanText(bad), (e) => e instanceof CleanError && e.message === 'clean_not_a_string' && e.code === 'clean_not_a_string');
  }
  assert.strictEqual(cleanText(null), ''); assert.strictEqual(cleanText(undefined), ''); assert.strictEqual(cleanText(''), '');
  try { cleanText('&amp;amp;amp;amp;amp;amp;lt;SECRET-INPUT'); assert.fail('should not settle'); } catch (e) { assert.ok(!String(e.message).includes('SECRET') && !String(e.stack).includes('SECRET-INPUT')); }
});

test('C10 the 20,000 cap: output never longer, never ends on half an emoji, and the capped text is stable', async () => {
  const lonely = cleanText('y'.repeat(19999) + '\u{1F600}'.repeat(50));
  assert.strictEqual(K.hasLoneSurrogate(lonely), false);
  assert.ok(lonely.length <= 20000);
  assert.strictEqual(cleanText(lonely), lonely);
  assert.strictEqual(cleanText('x '.repeat(500000)).length <= 20000, true);
  // links that grow the text ("a.co" -> "[link removed]") still end up capped and stable
  const grown = cleanText('a.co '.repeat(5000));
  assert.ok(grown.length <= 20000 && cleanText(grown) === grown);
  // a cut that would leave "evil.com" out of "evil.comx" settles instead of looping
  const edge = cleanText('q'.repeat(19991) + ' evil.comx');
  assert.strictEqual(cleanText(edge), edge);
});

test('C11 TIME LIMIT: 20,000-character hostile inputs finish the cleaner plus the screen in under 200 ms each', async () => {
  const n = 20000;
  const R = (s) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const hostile = {
    'repeated "<a"': R('<a'), 'repeated "<"': R('<'), 'repeated "<script"': R('<script'), 'repeated "<!--"': R('<!--'), 'repeated "</script"': R('</script '),
    'repeated "<style>"': R('<style>'), 'repeated "<br"': R('<br'), 'repeated "<p "': R('<p '),
    'one letter': 'a'.repeat(n), 'one space': ' '.repeat(n), 'one digit': '7'.repeat(n), 'one dot': '.'.repeat(n), 'one hyphen': '-'.repeat(n), 'one at-sign': '@'.repeat(n),
    'alternating letters': R('ab'), 'alternating dot-letter': R('a.'), 'alternating hyphen-letter': R('a-'), 'colon-run': R('a:'), 'slash-run': R('//'), 'letters then dot': 'a'.repeat(n - 1) + '.',
    'repeated "x "': R('x '), 'repeated "1 "': R('1 '), 'digits and dashes': R('1-'), 'digits for the SSN rule': R('123 45 6789 '), 'digits for the card rule': R('4111 1111 1111 '),
    'repeated "http:"': R('http:'), 'repeated "www."': R('www.'), 'repeated "a.co "': R('a.co '), 'repeated "[::"': R('[::'), 'repeated hex and colons': R('dead:beef:'),
    'repeated "wheelchair "': R('wheelchair '), 'repeated "domestic violence "': R('domestic violence '), 'repeated "ice agent"': R('ice agent '), 'repeated "restraining order "': R('restraining order '),
    'repeated "&amp;"': R('&amp;'), 'repeated "&lt;b&gt;"': R('&lt;b&gt;'), 'repeated "&"': R('&'),
    'invisible run': cp(0x200B).repeat(n), 'variation selectors': cp(0xFE0F).repeat(n), 'tag characters': cp(0xE0041).repeat(n / 2),
    'accented run': 'é'.repeat(n), 'combining marks': R('e\u{301}'), 'emoji run': cp(0x1F600).repeat(n / 2), 'CJK run': '你'.repeat(n), 'Cyrillic and Latin mix': R('aа'),
    'long alternation': R('(a|b|c|d|e|f)+'), 'repeated apostrophes': R("'"), 'repeated quotes': R('"'),
    'elongated letters': R('aaaaabbbbbbcccccc '), 'many long runs in one word': R('aaabbbcccddd'), 'symbol-letter swaps': R('@$01'),
    'nested entities': R('&amp;amp;lt;'),
    'repeated "xn--"': R('xn--'), 'hyphen runs between letters': R('a---'), 'host with a long hyphen tail': 'a.' + '-'.repeat(n - 2), 'hyphens then letters': '-'.repeat(n / 2) + R('a-b').slice(0, n / 2),
    'invisible characters between host labels': R('a\u200B.b\u200B'), 'unassigned code points': '\u0378'.repeat(n), 'tags between letters': R('a<b>'),
  };
  let worst = { ms: 0, name: '' };
  for (const [name, text] of Object.entries(hostile)) {
    assert.ok(text.length <= n + 4, `${name}: test input too long`);
    // best of three, so a busy machine (several suites at once) cannot fail the test by itself; a real slow path is slow every time
    let ms = Infinity;
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = process.hrtime.bigint();
      let cleaned = '';
      try { cleaned = cleanText(text); } catch (e) { assert.ok(e instanceof CleanError); }
      const verdict = screenMod.screenWorkOrderText({ title: '', description: cleaned });
      ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
      assert.ok(['cleared', 'held'].includes(verdict.status));
      if (ms < 100) break;
    }
    if (ms > worst.ms) worst = { ms, name };
    assert.ok(ms < 200, `${name} took ${ms.toFixed(1)} ms`);
  }
  process.stdout.write(`      (${Object.keys(hostile).length} hostile inputs; slowest "${worst.name}" at ${worst.ms.toFixed(1)} ms)\n`);
});

test('C12 a blown time budget in the cleaner is an error (fail closed); it recovers when restored', async () => {
  cleanMod._setBudgetMsForTesting(-1);
  try { assert.throws(() => cleanText('hello'), (e) => e instanceof CleanError && e.message === 'clean_over_budget'); } finally { cleanMod._setBudgetMsForTesting(); }
  assert.strictEqual(cleanText('hello'), 'hello');
  const s = await K.summaryMod.prepareWorkOrderSummary({ name: 'x', description: 'y' });
  assert.strictEqual(s.status, 'shown');
  cleanMod._setBudgetMsForTesting(-1);
  try {
    const held = await K.summaryMod.prepareWorkOrderSummary({ name: 'x', description: 'y' });
    // the time budget is one of the two "will not settle" causes: its own cause, not a scanner error
    assert.strictEqual(held.status, 'held'); assert.strictEqual(held.meta.cause, 'unsettled_text');
  } finally { cleanMod._setBudgetMsForTesting(); }
});

test('C13 the cleaner is pure: no I/O, no logging, no network, no model', async () => {
  const src = require('fs').readFileSync(path.resolve(H.APPROVAL_DIR, 'lib/work-order-text-clean.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/console\.|process\.env|require\(/.test(src), 'no logging, no environment, no requires at all');
  H.reset();
  cleanText('see http://evil.test and <b>x</b>');
  assert.strictEqual(H.logs.length, 0);
});

runner.run();
