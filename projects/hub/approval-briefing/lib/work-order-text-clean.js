/**
 * lib/work-order-text-clean.js
 *
 * The cleaner for the Work Order Alert "What the work order is" block. Takes
 * one raw Latchel field (job.name or job.description) and returns plain,
 * single-line text that is safe to put in an email AND is the exact string the
 * screen (work-order-text-screen.js) reads. Checked equals shown.
 *
 * THE RULES (each pass, in this order):
 *   1. NFKC normalisation (full-width letters, compatibility forms and the
 *      ideographic dots become ordinary characters, so hiding a keyword or a
 *      link in look-alike forms does not work). EXCEPT a short list of
 *      numerals and measurement marks (fractions, superscript and subscript
 *      digits, circled digits, the trademark and micro signs, primes), which
 *      stay exactly as typed: NFKC would turn "2 1/2" into "21/2" and a square
 *      foot sign into "52". The screen folds its own copy, so what it checks is
 *      still what is shown.
 *   2. Invisible characters are REMOVED, not turned into spaces, so
 *      "preg<invisible>nant" becomes "pregnant" and is caught. Removed:
 *      Default_Ignorable_Code_Point (zero-width, variation selectors including
 *      U+FE00-FE0F and U+E0100-E01EF, Hangul fillers U+115F/1160/3164/FFA0,
 *      U+180B-180F, U+2060-206F, soft hyphen, tag characters), control
 *      characters, format characters (bidi marks and overrides, BOM),
 *      private-use, lone surrogates and unassigned code points (including
 *      noncharacters such as U+FFFF), plus U+2800 and U+FFFC. Line breaks and
 *      tabs become a space first. "Unassigned" follows the Unicode tables of
 *      the Node version that runs this: a character newer than those tables is
 *      treated as unassigned and removed.
 *      KNOWN, ACCEPTED SIDE EFFECT: removing U+200C and U+200D splits emoji
 *      "ZWJ" sequences (a family or profession emoji) into separate emoji.
 *   3. Six HTML entities decoded (&amp; &lt; &gt; &quot; &#39; &nbsp;).
 *   4. HTML: script and style blocks dropped with their contents, comments
 *      dropped, tags removed (block tags become a space).
 *   5. Links replaced with "[link removed]" (see neutraliseLinks). A Title-case
 *      "word.Word" with an everyday-word ending (a sentence typed with no space
 *      after its full stop, "Leaking.Info needed") is ALSO how a brand-looking
 *      address is written, so it is replaced AND reported (`ambiguousLink`), and
 *      the caller holds the whole block. It is never shown as typed.
 *   6. Every run of whitespace, newlines included, becomes one space, so a
 *      description can never forge an extra line. Trimmed.
 *   7. Output capped at 20,000 UTF-16 units (never ending on half a pair).
 *
 * FOUR READINGS. Removing an invisible character or a tag glues the words on
 * either side together ("domestic<invisible>violence" shows as
 * "domesticviolence"), and the NFKC step turns a symbol such as the numero sign
 * or a squared unit sign into LETTERS ("food<numero sign>stamps" is
 * "foodNostamps"). cleanTextBoth() therefore also returns the same text read
 * the other ways, each cleaned by exactly the same rules:
 *   spaced   every removed invisible character and every removed tag is a SPACE
 *   symbols  every punctuation, symbol or space character that NFKC would turn
 *            into letters is a SPACE instead (see symbolsToSpaces; digit-like
 *            marks such as superscripts, fractions and circled digits are NOT
 *            touched, so they keep reading as digits)
 *   both     both of the above
 * Only `shown` is ever displayed; the screen reads all four and holds if any
 * one hits. A reading that would be identical to `shown` is not computed (it
 * is the same string). cleanText() returns `shown` alone.
 *
 * FIXED POINT. The steps above are repeated until a pass changes nothing
 * (at most MAX_PASSES = 6 passes; the last pass must be the one that changes
 * nothing, so a text may change in at most five passes). That is what makes
 * the cleaner IDEMPOTENT (clean(clean(x)) equals clean(x)) and guarantees the
 * output never matches its own link detector or contains a tag that was
 * assembled out of the pieces of another one ("<<b>b>"). Input that does not
 * settle in time is an error (codes clean_did_not_settle and
 * clean_over_budget, which the summary reports under their own cause, not as a
 * scanner error), and the caller holds the block (fail closed). Consequence: an entity such as "&amp;lt;" is decoded until
 * nothing more decodes, not "once". Ordinary double-escaped text settles. What
 * needs more than five changing passes does not: an entity escaped six or more
 * times over ("&amp;amp;amp;amp;amp;lt;" is six levels; five levels settle) or
 * a tag assembled out of six or more levels of pieces. (An earlier version of
 * this note said "five or more"; the code allows six passes in all.)
 *
 * NEVER LOG OR RETURN THE TEXT IN AN ERROR. Every error thrown here has a
 * constant message that contains no part of the input.
 *
 * Pure and synchronous: no model call, no network, no file, no logging.
 */

'use strict';

const RAW_INPUT_CAP = 20000;   // UTF-16 units kept from any one field
const MAX_PASSES = 6;
const LINK_TEXT = '[link removed]';

// Wall-clock budget for one cleanText call. JavaScript cannot interrupt a
// regular expression, so this is a check between passes: the work is bounded
// by the patterns below, and this makes a surprise slow path fail closed.
let BUDGET_MS = 1500;

class CleanError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CleanError';
    this.code = code;
  }
}

// ─── Pieces ─────────────────────────────────────────────────────────────────
const WHITESPACE_LIKE = /[\t\n\r\x0B\x0C\x85\u2028\u2029]/g;
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\u2800\uFFFC]/gu;
const INVISIBLE_TEST = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\u2800\uFFFC]/u;

// Numerals and measurement marks that NFKC would rewrite into something that
// reads differently, kept as typed (see rule 1): vulgar fractions, superscript
// and subscript digits and signs, circled digits, trademark / service mark,
// the Spanish ordinal marks, the micro sign and the prime marks.
const KEEP_AS_TYPED = /[\u00AA\u00B2\u00B3\u00B5\u00B9\u00BA\u00BC-\u00BE\u2032-\u2037\u2057\u2070\u2074-\u208E\u2120\u2122\u2150-\u215F\u2189\u2460-\u2473\u24EA\u24F5-\u24FE\u2776-\u2793\u3248-\u324F\u3251-\u325F\u32B1-\u32BF]/gu;
const KEEP_AS_TYPED_TEST = /[\u00AA\u00B2\u00B3\u00B5\u00B9\u00BA\u00BC-\u00BE\u2032-\u2037\u2057\u2070\u2074-\u208E\u2120\u2122\u2150-\u215F\u2189\u2460-\u2473\u24EA\u24F5-\u24FE\u2776-\u2793\u3248-\u324F\u3251-\u325F\u32B1-\u32BF]/u;

/** NFKC of everything except the KEEP_AS_TYPED characters, which pass through untouched. */
function nfkc(s) {
  if (!KEEP_AS_TYPED_TEST.test(s)) return s.normalize('NFKC');
  let out = '';
  let last = 0;
  for (const m of s.matchAll(KEEP_AS_TYPED)) {
    out += s.slice(last, m.index).normalize('NFKC') + m[0];
    last = m.index + m[0].length;
  }
  return out + s.slice(last).normalize('NFKC');
}

// ─── Symbols that stand for letters (R4-1) ─────────────────────────────────
// A punctuation, symbol or space character that NFKC would rewrite into LETTERS
// (the trademark and service-mark signs, the numero sign, care-of, degree
// Celsius, the squared unit signs, and the like). Typed where a space belongs
// ("food<numero sign>stamps") it is a separator, but NFKC glues it to the words
// on either side as letters. symbolsToSpaces() turns each one into a space, so
// the "symbols" reading of the text sees the words apart. It is never used for
// the displayed text.
//   NOT touched: digit-like marks (superscripts, fractions, circled digits and
//   the like are numbers, not punctuation or symbols: they keep reading as
//   digits for the notice and Social Security patterns), and circled,
//   parenthesised and squared single letters (they ARE letters, and spell
//   words that the other readings must keep catching).
//   ALSO touched, by name: the ordinal indicators (feminine and masculine), the
//   micro sign and the superscript n. They are letters by category, but they
//   are written as marks after a number (1 followed by the masculine ordinal
//   mark) and are not part of any word.
const NON_ASCII_TEST = /[^\x00-\x7F]/;
const SEPARATOR_CANDIDATE = /(?![\x00-\x7F])[\p{P}\p{S}\p{Z}\u00AA\u00BA\u00B5\u207F]/gu;
const LETTER_MARKS = new Set(['\u00AA', '\u00BA', '\u00B5', '\u207F']);
const foldsToLettersMemo = new Map();

function foldsToLetters(ch) {
  let v = foldsToLettersMemo.get(ch);
  if (v !== undefined) return v;
  v = false;
  if (LETTER_MARKS.has(ch)) {
    v = true;
  } else {
    const n = ch.normalize('NFKC');
    if (n !== ch && /\p{L}/u.test(n)) {
      // A circled, parenthesised or squared letter folds to ONE letter (with or without brackets or a stop): it is a letter.
      const rest = Array.from(n.replace(/[().\s]/g, ''));
      v = !(rest.length === 1 && /^\p{L}$/u.test(rest[0]));
    }
  }
  foldsToLettersMemo.set(ch, v);
  return v;
}

/** `s` with every symbol that NFKC would turn into letters replaced by a space. Returns `s` itself when there is none. */
function symbolsToSpaces(s) {
  if (!NON_ASCII_TEST.test(s)) return s;
  return s.replace(SEPARATOR_CANDIDATE, (ch) => (foldsToLetters(ch) ? ' ' : ch));
}

const BLOCK_TAGS = /<\/?(?:br|p|div|li|ul|ol|tr|td|th|table|h[1-6])\b[^<>]*>/gi;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

// [^<>]* (never [^>]*) in every tag pattern: a run of "<a<a<a..." with no
// closing ">" then costs a straight line instead of a quadratic scan.
const SCRIPT_BLOCK = /<script\b[^<>]*>[\s\S]*?(?:<\/script\s*>|$)/gi;
const STYLE_BLOCK = /<style\b[^<>]*>[\s\S]*?(?:<\/style\s*>|$)/gi;
const COMMENT_BLOCK = /<!--[\s\S]*?(?:-->|$)/g;
const ANY_TAG = /<\/?[a-zA-Z][^<>]*>/g;
const ANY_TAG_TEST = /<\/?[a-zA-Z][^<>]*>/;

// ─── Links ──────────────────────────────────────────────────────────────────
// Scheme names from an explicit denylist. Never "any word followed by a colon":
// "Note:call" and "Time:10:30" are plain text.
const SCHEMES = 'https?|ftps?|sftp|file|mailto|tel|sms|javascript|data|vbscript|blob|wss?|ssh|smb|intent|'
  + 'skype|facetime|facetime-audio|callto|sips?|maps|geo|imessage|cid|about|view-source|ms-msdt|search-ms|magnet|whatsapp|tg|zoommtg|zoomus|itms|itms-apps|itms-services';
const SCHEME_URL = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${SCHEMES}):\\S+`, 'giu');
const PROTOCOL_RELATIVE = /(?<![\p{L}\p{N}/])\/\/[\p{L}\p{N}]\S*/gu;
const WWW_HOST = /(?<![\p{L}\p{N}@._-])www\d{0,3}[.\u3002]\S+/giu;
const IPV6_BRACKETED = /\[([0-9a-f:.]{2,45})\](?::\d{1,5})?(?:[/?#]\S*)?/giu;
const IPV6_BARE = /(?<![\p{L}\p{N}:.])[0-9a-f:]{3,39}(?![\p{L}\p{N}:])/giu;
// A dotted host name. Boundaries: not inside a word (a letter or digit right
// before it, or a letter or digit and a run of hyphens before it, which keeps a
// long "a-a-a-a" or "xn--xn--xn--" run linear; the first check, that a letter or
// digit is next, keeps a long run of hyphens from being walked back over at
// every position). A "." "_" or "@" before it does NOT protect it
// ('.evil.com', '_evil.com' and 'user@evil.com/login' are links, and so is a
// host that starts a token with a hyphen); the replacer below decides the two
// plain e-mail cases (the part before an "@" and the domain after one).
// The lookahead after the last label stops it ending in the middle of a word.
const HOST_CANDIDATE = new RegExp(
  '(?=[\\p{L}\\p{N}])(?<![\\p{L}\\p{N}])(?<![\\p{L}\\p{N}]-+)' +
  '((?:[\\p{L}\\p{N}][\\p{L}\\p{N}\\-]*[.\\u3002])+[\\p{L}\\p{N}][\\p{L}\\p{N}\\-]*)' +
  '(?![\\p{L}\\p{N}]|[.\\u3002][\\p{L}\\p{N}])' +
  '(:\\d{1,5}(?![\\p{L}\\p{N}]))?' +
  '([/?#]\\S*)?',
  'giu',
);

// Common and abuse-prone top-level domains (at least 40). Two-letter English
// words that are also country codes (in, to, is, it, at, be, so, my, no, by,
// as, do, go, am, pm, id, st) are left out on purpose, so "leak.in the ceiling"
// is not mangled; a host that uses one of them still needs a path, port or
// query to be caught (or a second-level label, see SECOND_LEVEL).
const TLDS = new Set((`
  com net org info biz edu gov mil int io co me us xyz top club online site shop store tk ml ga cf gq
  ru cn cc ws tv ly sh gl app dev link click live ink buzz work support icu vip cam rest fit loan win
  men bid stream download zip mov page cloud tech fun space website life world today news email
  services solutions uk de br ng pw su kz ua ir pro name mobi asia agency digital finance bank
  money cash credit pay loans casino bet poker sex xxx porn adult date dating gift gifts promo
  review reviews party racing science trade webcam monster cyou sbs cfd lol rip fyi wtf
  mx ca fr nl eu es au nz pl se fi dk ch pt gr ie il jp kr tw hk sg ph vn th za ar cl pe ve ec bo py
  uy cr pa gt hn sv ni cu pr jm tt bs bb ag ai al ao aw ax az ba bd bf bg bh bi bj bm bn bt bw bz cd
  cg ci ck cm cv cw cx cy cz dj dm dz ee eg er et fj fk fm fo ge gf gg gh gi gm gn gp gs gu gw gy hm
  hr ht hu im iq je jo ke kg kh ki km kn kp kw ky la lb lc li lk lr ls lt lu lv ma mc md mg mh mk mm
  mn mo mp mq mr ms mt mu mv mw mz na nc ne nf nr nu om pf pg pk ps qa re ro rs rw sa sb sc sd si sk
  sl sm sn sr ss sx sy sz tc td tf tg tj tl tm tn tr tz ug uz va vc vg vi vu wf ye yt zm zw
  company group network systems center host tel academy login zone museum global international
  foundation institute education school college agency media tools technology software expert
  support help care health bio ventures capital partners holdings enterprises industries
  exchange market markets trading invest investments insurance bargains deals coupons discount sale
  tickets travel hotel flights cheap cheapest free best рф рус онлайн сайт 中国 中國 香港 台灣 台湾 日本 한국 ไทย भारत
`).split(/\s+/).filter(Boolean));

// The top-level domains that are also ordinary English words. A missing space
// after a full stop ("Leaking.Info needed", "8:30.Today only") makes a Title-case
// sentence start look like one of these, and a brand-looking address ("Chase.Bank")
// is written the same way, so the shape cannot be told apart by looking at it.
// It is therefore NEVER shown as typed: the host is replaced by "[link removed]"
// and the cleaner reports `ambiguousLink`, which makes the caller hold the whole
// block (see looksLikeSentenceBreak and replaceHost). This list only decides
// "hold the block" versus "replace the link and show the rest"; it is no longer an
// exemption from the link rule. Lower-case ("rincon.support"), upper-case, longer
// chains and anything with a path, port or query are still plain links.
const SENTENCE_BREAK_ENDINGS = new Set((`
  info work support today life site page name live top date fit space rest link click online news
  world email services solutions review reviews party trade science cloud tech fun website digital
  agency finance money cash credit pay loan loans win men bid stream download shop store club gift
  gifts promo racing bank bet app zip me us pro buzz ink help care health media tools technology
  software expert zone global market markets trading exchange group center network company
  foundation institute education school college international ventures capital partners holdings
  insurance travel hotel sale deals tickets best free cheap discount
`).split(/\s+/).filter(Boolean));

// The country codes that are also everyday two-letter words, left out of TLDS on
// purpose (see above). A host on one of them is still a link when the label
// before it contains a hyphen ("word-word.xx": an ordinary sentence almost never
// looks like that), unless the code is written Title-case like the start of a
// sentence.
const EVERYDAY_CODES = new Set(['in', 'to', 'is', 'it', 'at', 'be', 'so', 'my', 'no', 'by', 'as', 'do', 'am', 'pm', 'id', 'st', 'ac']);

// Second-level labels of country domains: evil.co.in, evil.com.au, evil.org.uk.
// With one of these before a two-letter country code the host is a link even
// when the code itself is a common English word (in, it, no ...).
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'ne', 'or', 'go']);

// Link shorteners and messaging redirects, matched as a whole host.
const SHORTENERS = new Set((`
  bit.ly t.co goo.gl tinyurl.com ow.ly is.gd buff.ly rb.gy cutt.ly shorturl.at wa.me t.me youtu.be
  lnkd.in fb.me amzn.to tiny.cc bit.do v.gd s.id soo.gd trib.al t.ly rebrand.ly short.io x.co ift.tt
  dlvr.it adf.ly bl.ink lin.ee linktr.ee qr.ae wp.me j.mp po.st snip.ly tr.im u.to clck.ru vk.cc
`).split(/\s+/).filter(Boolean));

// Measurements written like domains ("add 6.ml of sealant", "drill a 5.mm hole",
// "10.kg"): a number (or several, "2.5.mm") then one of these unit endings, which
// are also country codes. ONLY these. Any other two-letter ending after a number
// ("12345.tk", "99.ws") is a web address and is replaced.
const UNIT_ENDINGS = new Set(['mm', 'cm', 'km', 'kg', 'lb', 'ml', 'mg', 'ma', 'mv', 'mw', 'kw']);

function isIpv4(labels) {
  if (labels.length !== 4) return false;
  return labels.every((l) => /^\d{1,3}$/.test(l) && Number(l) <= 255);
}

function isIpv6(text) {
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(':')) return false;
  let t = text;
  // An embedded IPv4 tail (::ffff:1.2.3.4) counts as two groups.
  const v4 = t.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4) t = `${t.slice(0, -v4[1].length)}0:0`;
  if (t.includes('.')) return false;
  const doubles = t.split('::').length - 1;
  if (doubles > 1) return false;
  const groups = t.split(':').filter((g, i, a) => !(g === '' && (i === 0 || i === a.length - 1 || doubles)));
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return false;
  return doubles === 1 ? groups.length <= 7 : (t.split(':').length === 8 && groups.length === 8);
}

/**
 * "Word.Capitalised" with a letters-only (or digits-only) word before the dot
 * and an English-word domain ending in Title case after it: either a sentence
 * typed with no space after its full stop, or a brand-looking address. The two
 * cannot be told apart, so the caller holds the block (see replaceHost).
 */
function looksLikeSentenceBreak(labels, origLast, tldCore) {
  if (labels.length !== 2 || !SENTENCE_BREAK_ENDINGS.has(tldCore)) return false;
  if (!/^\p{Lu}\p{Ll}+$/u.test(origLast.split('-')[0])) return false;
  return /^(?:\p{L}+|\p{N}+)$/u.test(labels[0]);
}

/**
 * True when the "@" at `atIndex` has a name in front of it: a letter or digit
 * right before it, and the run of name characters it belongs to does not start
 * right after another "@". So "ceo@host" has a name; "@host", " @host",
 * "(@host)", "-@host" and "@@host" do not.
 */
function hasNameBeforeAt(whole, atIndex) {
  if (atIndex < 1 || !/[\p{L}\p{N}]/u.test(whole[atIndex - 1])) return false;
  let i = atIndex - 1;
  const stop = Math.max(0, atIndex - 64);
  while (i > stop && /[\p{L}\p{N}._%+'-]/u.test(whole[i - 1])) i--;
  return !(i > 0 && whole[i - 1] === '@');
}

// The domain written right after an "@" (letters, digits and hyphens in labels, at least one dot).
const EMAIL_DOMAIN = /(?:[\p{L}\p{N}][\p{L}\p{N}-]*[.\u3002])+[\p{L}\p{N}][\p{L}\p{N}-]*/uy;

/**
 * True when the text right after the "@" at `atIndex` is itself a host: at
 * least one dot and a LISTED ending (TLDS, or one of the everyday two-letter
 * country codes) that is the whole last label. "name@example.com" has one;
 * "x@x", "x@1", "x@x.y" and "x@x.unlistedending" do not. Only then is the
 * part in front of the "@" an e-mail name rather than a web address of its own.
 */
function domainAfterAtIsHost(whole, atIndex) {
  EMAIL_DOMAIN.lastIndex = atIndex + 1;
  const dm = EMAIL_DOMAIN.exec(whole);
  if (!dm) return false;
  const labels = dm[0].toLowerCase().split(/[.\u3002]/);
  const ending = labels[labels.length - 1];
  return TLDS.has(ending) || EVERYDAY_CODES.has(ending);   // (EMAIL_DOMAIN already needs at least one dot)
}

/**
 * Where the host really ends. HOST_CANDIDATE reads letters and digits of every
 * script as part of the last label, so "evil.zone" followed by a superscript
 * two, a fraction, a circled digit, an ordinal mark or a letter with an accent
 * would read as the unlisted ending "zone<mark>" and be shown as typed. A mail
 * program that looks for plain ASCII hosts stops at that character and links
 * "evil.zone". So the host ends at the first character after the ASCII letters
 * and digits of its last label that is not an ASCII letter or digit (a hyphen
 * keeps its own meaning). Returns the length of the host within `host`, or -1
 * when it ends where HOST_CANDIDATE said it does.
 */
function asciiHostEnd(host) {
  const lastDot = Math.max(host.lastIndexOf('.'), host.lastIndexOf('\u3002'));
  const label = host.slice(lastDot + 1);
  const ascii = /^[A-Za-z0-9]+/.exec(label);
  if (!ascii || ascii[0].length === label.length) return -1;
  const next = label[ascii[0].length];
  return next === '-' ? -1 : lastDot + 1 + ascii[0].length;
}

/** True when the host (no tail after it) must be replaced. `sink` learns about the sentence-break shape. */
function hostIsLink(host, hasTail, sink) {
  const labels = host.toLowerCase().split(/[.\u3002]/);
  const origLast = host.split(/[.\u3002]/).pop();
  if (labels.some((l) => l.startsWith('xn--'))) return true;
  if (isIpv4(labels)) return true;
  if (SHORTENERS.has(labels.join('.'))) return true;
  const tld = labels[labels.length - 1];
  // "evil.com-login": the last label may carry a hyphenated tail; its first part is the domain ending.
  const tldCore = tld.split('-')[0];
  if (!/^\p{L}{2,}$/u.test(tldCore)) return false;      // 1.5/2, approx.2, No.5/6, 555.123.4567, e.g.
  if (hasTail) return true;                              // a bare host with a path, port, query or fragment
  if (UNIT_ENDINGS.has(tldCore) && labels.slice(0, -1).every((l) => /^\p{N}{1,4}$/u.test(l))) return false; // units: 5.mm, 3.cm, 6.ml, 2.5.mm
  if (TLDS.has(tldCore)) {
    // Never shown as typed: replaced, and the whole block is held when it is the sentence-break shape.
    if (sink && looksLikeSentenceBreak(labels, origLast, tldCore)) sink.ambiguousLink = true;
    return true;
  }
  if (labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]) && /^[a-z]{2}$/.test(tldCore)) return true; // evil.co.in
  if (EVERYDAY_CODES.has(tldCore) && /[\p{L}\p{N}]-[\p{L}\p{N}]/u.test(labels[labels.length - 2])) {
    // chase-verify.in is a link. Written Title-case ("up-to-date.In the garage") it is also
    // the start of a sentence: replaced, and the block is held, like the other sentence-break shape.
    if (sink && /^\p{Lu}\p{Ll}$/u.test(origLast.split('-')[0])) sink.ambiguousLink = true;
    return true;
  }
  return false;                                          // not sink.leak, e.g., i.e.
}

function replaceHost(m, host, port, rest, offset, whole, sink) {
  // R4-3: the host ends at the first character after its ending that is not an
  // ASCII letter or digit; whatever follows is not part of it. When the host cut
  // there is a link, only the host is replaced and the rest stays. When it is
  // not, the host is judged as a whole, exactly as before (so nothing that was
  // replaced before is shown now).
  const cut = asciiHostEnd(host);
  if (cut >= 0 && hostIsLink(host.slice(0, cut), false, sink)) return LINK_TEXT + m.slice(cut);
  const hasTail = !!(port || rest);
  const before = offset > 0 ? whole[offset - 1] : '';
  const after = whole[offset + m.length] || '';
  // A plain e-mail address is left alone: the part before the "@" (only when
  // the text after the "@" is itself a host with a dot and a listed ending: R4-2,
  // so "web.address@x" is not an address and the web-like word before the "@"
  // is replaced) and the domain after it (when nothing like a path or port
  // follows, and the "@" has a name in front of it). An "@" with no name before
  // it, or a doubled one, is not an address.
  if (!hasTail && after === '@' && domainAfterAtIsHost(whole, offset + m.length)) return m;
  if (!hasTail && before === '@' && hasNameBeforeAt(whole, offset - 1)) return m;
  return hostIsLink(host, hasTail, sink) ? LINK_TEXT : m;
}

/**
 * Replaces every link-like piece with LINK_TEXT. Pure; also the link detector.
 * `sink` (optional) learns `ambiguousLink = true` when a replaced piece had the
 * sentence-break shape (see looksLikeSentenceBreak).
 */
function neutraliseLinks(s, sink) {
  let out = s.replace(SCHEME_URL, LINK_TEXT);
  out = out.replace(PROTOCOL_RELATIVE, LINK_TEXT);
  out = out.replace(WWW_HOST, LINK_TEXT);
  out = out.replace(IPV6_BRACKETED, (m, inner) => (isIpv6(inner) ? LINK_TEXT : m));
  out = out.replace(IPV6_BARE, (m) => (m.includes('::') || m.split(':').length === 8) && isIpv6(m) ? LINK_TEXT : m);
  out = out.replace(HOST_CANDIDATE, (m, host, port, rest, offset, whole) => replaceHost(m, host, port, rest, offset, whole, sink));
  return out;
}

/** True when `s` still contains something the link rules would replace. */
function containsLink(s) {
  return neutraliseLinks(s) !== s;
}

/**
 * True when `s` has no link as typed, but its NFKC reading (the one a mail
 * program or browser may apply: the Spanish ordinal marks, for instance, are
 * kept as typed yet fold to the letters a and o) does. Such text is never shown;
 * the caller holds the block.
 */
function hasFoldedLink(s) {
  if (!KEEP_AS_TYPED_TEST.test(s)) return false;
  const folded = s.normalize('NFKC');
  return folded !== s && containsLink(folded);
}

// ─── One pass, and the fixed-point loop ─────────────────────────────────────
function capOutput(s) {
  if (s.length <= RAW_INPUT_CAP) return s;
  let t = s.slice(0, RAW_INPUT_CAP);
  if (/[\uD800-\uDBFF]$/.test(t)) t = t.slice(0, -1);
  return t;
}

// `probe` (shown reading only) learns whether anything that differs between the
// two readings was ever present: an invisible character or a tag to remove.
// When nothing was, the spaced reading IS the shown one and is not computed.
function onePass(input, spaced, probe, sink, separate) {
  let s = nfkc(separate ? symbolsToSpaces(input) : input);
  s = s.replace(WHITESPACE_LIKE, ' ');
  if (probe && INVISIBLE_TEST.test(s)) probe.removal = true;
  s = s.replace(INVISIBLE, spaced ? ' ' : '');
  // Entities first, then markup, so "&lt;script&gt;" is dropped in the same
  // pass instead of needing another one.
  s = s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_m, name) => ENTITIES[name]);
  s = s.replace(SCRIPT_BLOCK, ' ').replace(STYLE_BLOCK, ' ').replace(COMMENT_BLOCK, ' ');
  s = s.replace(BLOCK_TAGS, ' ');
  if (probe && ANY_TAG_TEST.test(s)) probe.removal = true;
  s = s.replace(ANY_TAG, spaced ? ' ' : '');
  s = neutraliseLinks(s, sink);
  s = s.replace(/\s+/g, ' ').trim();
  return capOutput(s).trim();
}

function elapsedMs(started) {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function settle(value, spaced, started, probe, sink, separate) {
  let current = capOutput(value);
  for (let i = 0; i < MAX_PASSES; i++) {
    const next = onePass(current, spaced, probe, sink, separate);
    if (elapsedMs(started) > BUDGET_MS) throw new CleanError('clean_over_budget');
    if (next === current) {
      // Belt and braces: the guarantees the rest of the feature relies on.
      if (/[\r\n]/.test(next) || INVISIBLE_TEST.test(next) || containsLink(next)) throw new CleanError('clean_invariant');
      if (hasFoldedLink(next)) sink.ambiguousLink = true;
      return next;
    }
    current = next;
  }
  throw new CleanError('clean_did_not_settle');
}

/**
 * @param {string|null|undefined} value
 * @returns {string} '' for null, undefined or nothing left after cleaning.
 * @throws {CleanError} for a non-string value, or input that will not settle
 *   within MAX_PASSES, or a blown time budget. Messages are constant codes.
 */
function cleanText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new CleanError('clean_not_a_string');
  return settle(value, false, process.hrtime.bigint(), undefined, { ambiguousLink: false });
}

/**
 * The displayed text AND the other readings (see FOUR READINGS above), plus
 * `ambiguousLink`: true when a replaced link had the sentence-break shape
 * ("Leaking.Info needed": also how a brand-looking address is written), or when
 * the text has a link only in its NFKC reading. The caller must hold the whole
 * block then; the text is never shown as typed. Only the displayed reading and
 * the spaced one can ask for that hold (the symbols readings exist only so the
 * screen can see the words apart).
 * @returns {{shown: string, spaced: string, symbols: string, both: string, ambiguousLink: boolean}}
 * @throws {CleanError} as cleanText(); any reading failing fails all of them.
 */
function cleanTextBoth(value) {
  if (value === null || value === undefined) return { shown: '', spaced: '', symbols: '', both: '', ambiguousLink: false };
  if (typeof value !== 'string') throw new CleanError('clean_not_a_string');
  const started = process.hrtime.bigint();
  const probe = { removal: false };
  const sink = { ambiguousLink: false };
  const shown = settle(value, false, started, probe, sink);
  const spaced = probe.removal ? settle(value, true, started, undefined, sink) : shown;
  const typed = capOutput(value);
  const hasSymbols = symbolsToSpaces(typed) !== typed;
  const ignored = { ambiguousLink: false };
  const symbols = hasSymbols ? settle(value, false, started, undefined, ignored, true) : shown;
  const both = hasSymbols ? (probe.removal ? settle(value, true, started, undefined, ignored, true) : symbols) : spaced;
  return { shown, spaced, symbols, both, ambiguousLink: sink.ambiguousLink };
}

module.exports = {
  cleanText,
  cleanTextBoth,
  symbolsToSpaces,
  containsLink,
  hasFoldedLink,
  neutraliseLinks,
  CleanError,
  LINK_TEXT,
  RAW_INPUT_CAP,
  MAX_PASSES,
  INVISIBLE_TEST,
  KEEP_AS_TYPED_TEST,
  TLDS,
  SENTENCE_BREAK_ENDINGS,
  UNIT_ENDINGS,
  EVERYDAY_CODES,
  SHORTENERS,
  // test seam
  _setBudgetMsForTesting(ms) { BUDGET_MS = ms === undefined ? 1500 : ms; },
};
