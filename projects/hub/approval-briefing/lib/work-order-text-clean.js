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

// ═══ THE OWNER'S "NO CONTENT SCREEN" PATH (WORK_ORDER_ALERT_DESCRIPTION_SCREEN=off) ═══
// Added 2026-10-17 on Peter's explicit instruction (nothing held, nothing sent back
// to Latchel; recorded as an owner override in the decision record, never as met).
// When that switch is off the word-list screen is NOT consulted, so nothing is held for
// what the text says. The two functions below are everything that path adds to this
// file. They are NOT a screen: they never decide show-or-hide, they only
//   (a) make the text safe to print (the same cleaning as above, with a web-like
//       token neutralised instead of the block being held), and
//   (b) replace, as a best effort and not a guarantee, the known shapes of some strings
//       that must never be written into an inbox under Peter's standing rule (no SSNs,
//       bank account numbers or passwords in any file or table): see maskNeverStore.
// Phone numbers, e-mail addresses, names and gate or lockbox codes are NOT masked
// (Peter's earlier decision). The default path (screen on) never calls either function.

const MASK_TEXT = '[removed]';

// The decimal digit of any script as a plain 0-9 string (other characters dropped).
const ND_ONE = /\p{Nd}/u;
function digitsOf(s) {
  let out = '';
  for (const ch of s) {
    if (!ND_ONE.test(ch)) continue;
    const cp = ch.codePointAt(0);
    if (cp >= 0x30 && cp <= 0x39) { out += ch; continue; }
    let zero = cp;
    while (zero > 0 && ND_ONE.test(String.fromCodePoint(zero - 1))) zero--;
    out += String((cp - zero) % 10);
  }
  return out;
}

function luhnOk(digits) {
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

const KW_START = '(?<![\\p{L}\\p{N}])';
const KW_END = '(?![\\p{L}\\p{N}])';
const PUNCT = '[\\s:=#.\\-\\u2013\\u2014>]';
// A few filler words that may sit between a keyword and its value ("account number is 123...").
const FILL_WORDS = 'number|numbers|num|no|nr|numero|n\\u00FAmero|is|es|are|was|the|my|our|bank|checking|savings|de|del|bancaria|corriente|ahorros';
const FILLER = `(?:${PUNCT}{1,6}(?:${FILL_WORDS})${KW_END}){0,4}${PUNCT}{0,6}`;
const SEP = '[ \\-\\u2010-\\u2015\\u2212]';
// A run of digit groups (two or more digits each) with single spaces or dashes between them.
const NUMBER_RUN = `\\p{Nd}{2,}(?:${SEP}\\p{Nd}{2,})*`;

/** keyword, filler, value: the value (only) is replaced when `decide(value)` says so. */
function keywordRule(keywords, valueSrc, decide) {
  const re = new RegExp(`(${KW_START}(?:${keywords})${KW_END}${FILLER})(${valueSrc})`, 'giu');
  return (s) => s.replace(re, (m, head, value) => (decide(value) ? head + MASK_TEXT : m));
}

const PHONE_SHAPE = /^\(?\p{Nd}{3}\)?[ .\-]\p{Nd}{3}[ .\-]\p{Nd}{4}$/u;       // phone numbers pass through (Peter's decision)
const DATE_SHAPE = /^(?:\p{Nd}{4}[ \-]\p{Nd}{2}[ \-]\p{Nd}{2}|\p{Nd}{1,2}[ \-]\p{Nd}{1,2}[ \-]\p{Nd}{2,4})$/u;

/** A date shape is only a date when its numbers can be one: year-month-day, or month-day-year / day-month-year (year 1900 to 2199, or two digits). */
function isRealDate(v) {
  if (!DATE_SHAPE.test(v)) return false;
  const p = v.split(/[ \-]/u).map((x) => digitsOf(x));
  const [a, b, c] = p.map(Number);
  const inYears = (y) => y >= 1900 && y <= 2199;
  if (p[0].length === 4) return inYears(a) && b >= 1 && b <= 12 && c >= 1 && c <= 31;
  if (p[2].length === 3 || (p[2].length === 4 && !inYears(c))) return false;
  return (a >= 1 && a <= 12 && b >= 1 && b <= 31) || (a >= 1 && a <= 31 && b >= 1 && b <= 12);
}

// "account", "acct", "routing", "aba", "rtn" or Spanish "cuenta", then a number of at least six digits.
const maskAccountNumbers = keywordRule('accounts?|acct|routing|aba|rtn|cuenta', NUMBER_RUN, (v) => {
  if (digitsOf(v).length < 6) return false;
  return !(PHONE_SHAPE.test(v) || isRealDate(v));
});

// "card", a card brand or Spanish "tarjeta", then 13 to 19 digits (no check digit needed: the word says it is a card).
const maskCardsByWord = keywordRule('cards?|credit card|debit card|tarjeta|visa|mastercard|master card|amex|american express|discover', NUMBER_RUN, (v) => {
  const n = digitsOf(v).length;
  return n >= 13 && n <= 19;
});

// "ssn", "social security", "social" and the like, then exactly nine digits (dashes or spaces allowed).
const maskSocialByWord = keywordRule(
  'ssn|ss ?#|social security|social sec|social|soc sec|seguro social',
  '\\p{Nd}{3}[ \\-\\u2010-\\u2015\\u2212]?\\p{Nd}{2}[ \\-\\u2010-\\u2015\\u2212]?\\p{Nd}{4}(?!\\p{Nd})',
  () => true,
);

// "cvv", "cvc", "csc" and the 3 or 4 digit code after it.
const maskSecurityCodes = keywordRule('cvv2?|cvc2?|csc', '\\p{Nd}{3,4}(?!\\p{Nd})', () => true);

// "iban" and the code after it (two letters, two digits, then up to 30 letters and digits). The value may run on over the next
// words, but never over a second "iban" (so "iban X and iban Y" masks both).
const maskIbans = keywordRule('iban', '[A-Za-z]{2}\\p{Nd}{2}(?: ?(?!iban(?![A-Za-z0-9]))[A-Za-z0-9]){10,30}(?![A-Za-z0-9])', () => true);

// "swift" or "bic", optionally followed by "code", "number" or similar, then an 8 or 11 character code that has a digit or is all
// capitals (so "swift response" and "swift repairs" are not touched; "SWIFT: DEUTDEFF" and "swift DEUTDEFF" are).
const SWIFT_RE = new RegExp(
  `(${KW_START}(?:swift|bic)${KW_END}(?:[\\s:=#.\\-/]{1,6}(?:code|number|no|num|is|bic|swift)${KW_END}){0,3}[\\s:=#.\\-/]{1,6})`
  + '([A-Za-z]{6}[A-Za-z0-9]{2}(?:[A-Za-z0-9]{3})?(?![A-Za-z0-9]))', 'giu');
// A password word typed in capitals right after "swift" ("SWIFT PASSWORD: x") is not a code: the password rules read it.
const SWIFT_NOT_A_CODE = /^(?:password|passcode|contrasenas)$/i;
function maskSwiftCodes(s) {
  return s.replace(SWIFT_RE, (m, head, code) => (!SWIFT_NOT_A_CODE.test(code) && (/\p{Nd}/u.test(code) || code === code.toUpperCase()) ? head + MASK_TEXT : m));
}

// "password", "passcode", "pwd", Spanish "contrasena", then a value. The value is masked when the word is joined to it by a
// colon, an equals sign or "is" / "es", or when the word standing alone looks like a secret (a digit, a symbol inside it, or
// a capital in the middle). Everyday follow-on words ("password reset", "password for the portal", "password is wrong") stay.
// Three readings, in this order: (1) a colon or equals sign whose first word is an everyday word but which is followed by
// words that look like a passphrase ("password: correct horse battery"); (2) a few filler words between the keyword and the
// value ("the password for the portal is hunter2", "password for wifi: Summer2024", "password reset to Temp1234"), or "to" /
// "be" / "as" / "now" straight after the keyword when the value looks like a secret ("changed the password to Rincon2026",
// "password will be Welcome1"); (3) the value right after the keyword (the original rule). After a value is masked, up to three
// more password-like values joined to it by "/", a comma, "and" and the like are masked with it ("Passwords: Maria1990 / Pedro1991").
// None of the three ever takes the keyword of another mask rule (or another password word) as a value or reads a phrase past one.
const PW_STOP = new Set((`
  the a an to for on in of at by and or but if is are was were be been being has have had do does did not no nor never wrong
  incorrect invalid expired missing blank empty correct needed needs need required requires reset resets changed change changes
  working works work worked broken locked saved set default same still just now new old weak strong protected manager that this
  it its your my our their his her tenant owner vendor too very also please pls thanks thank cant cannot couldnt wont didnt
  doesnt isnt wasnt arent dont unknown forgot forgotten lost unable issue problem problems error errors failed fails fail
  sent emailed texted called provided given issued created updated deleted removed requested completed complete resolved fixed verified
  confirmed accepted rejected denied approved posted received delivered submitted taken done ready active disabled enabled valid
  ok okay fine good bad shared written listed attached included stored taped printed encrypted see none na n/a installed managed configured activated deactivated pending available unavailable
  with from already held kept
  el la los las un una de del en por para y o que es incorrecta incorrecto invalida invalido expirada expirado nueva nuevo
  vieja viejo cambiada cambio olvido olvidada perdida problema falla mal bien ya aun todavia
`).split(/\s+/).filter(Boolean));
const PW_KEYWORD_SRC = 'passwords?|passcodes?|pass code|passwd|passphrase|pwd|contrase[n\\u00F1]as?';
const PW_KEYWORD = `${KW_START}(?:${PW_KEYWORD_SRC})${KW_END}`;
// The keywords of the other mask rules (Social Security, account, routing, card, security code, IBAN, SWIFT). A password rule
// never takes one of them as its value and never reads a phrase past one or past another password word, so what stands after
// the word is left for the rule that owns it (and the keyword stays visible in the printed text). The rules that need a keyword
// run before the password rules (maskNeverStore), except the IBAN rule, which runs after them because its value can run on into
// the next words.
const RULE_KEYWORD_SRC = 'ssn|social|soc sec|accounts?|acct|routing|aba|rtn|cuenta|cards?|tarjeta|visa|mastercard|master card|amex|american express|discover|cvv2?|cvc2?|csc|iban|swift|bic';
const ANY_KEYWORD = new RegExp(`${KW_START}(?:${PW_KEYWORD_SRC}|${RULE_KEYWORD_SRC})${KW_END}`, 'iu');
const RULE_KEYWORD_WORD = new RegExp(`^(?:${RULE_KEYWORD_SRC})$`, 'iu');
const PW_VALUE = '(\\[link removed\\]|\\[removed\\]\\S*|["\'\\u201C\\u2018\\u00AB`][^"\'\\u201D\\u2019\\u00BB`]{1,40}["\'\\u201D\\u2019\\u00BB`]|\\S+)';
const PASSWORD_RE = new RegExp(
  `(${PW_KEYWORD})`
  + `([\\s:=\\-\\u2013\\u2014>]{0,6}(?:(?:is|es|are|was|era|son)${KW_END}[\\s:=\\-\\u2013\\u2014>]{0,6})?)`
  + PW_VALUE, 'giu');
// (2) filler words of letters between the keyword and the value, then a colon / equals sign, "is" / "was" ... or "to" / "be" /
// "as" / "now" (the last four only for a value that looks like a secret): read one word at a time (see passwordFillerValue) so a
// connector word that is only an everyday word ("... was reset to Temp1234") does not hide the real one.
const PW_KEYWORD_G = new RegExp(PW_KEYWORD, 'giu');
const PW_FILLER_WORD = /\s+[\p{L}'\u2019]{1,15}(?![\p{L}\p{N}'\u2019])/uy;
const PW_CONNECTOR = new RegExp(`(\\s{0,3}[:=]\\s{0,3})|(\\s+(?:is|es|are|was|era|son)${KW_END}\\s{1,3})|(\\s+(?:to|be|as|now)${KW_END}\\s{1,3})`, 'iuy');
const PW_VALUE_AT = new RegExp(PW_VALUE, 'uy');
// the next value of a list ("Maria1990 / Pedro1991", "A1b2, C3d4 and E5f6")
const PW_NEXT = new RegExp(`(?:\\s*[/|&,;]\\s*|\\s+(?:and|or|y|o)${KW_END}\\s+)`, 'iuy');
// (1) a colon or equals sign (after at most four filler words), then up to five plain words
const PW_WORD_SRC = "\\p{L}[\\p{L}'\\u2019-]*[.,;!?]*(?![\\p{L}\\p{N}_@#$%^&*+=~\\\\|<>/])";
const PW_WORD_G = new RegExp(PW_WORD_SRC, 'gu');
const PW_PHRASE_RE = new RegExp(
  `(${PW_KEYWORD})((?:\\s+[\\p{L}'\\u2019]{1,15}){0,4}\\s{0,3}[:=]\\s{0,3})(${PW_WORD_SRC}(?:\\s+${PW_WORD_SRC}){0,4})`, 'giu');
const PW_EMAIL = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/u;

/** The value token of a password match, normalised: its text without trailing punctuation, that punctuation, the bare word, and what it looks like. */
function pwValue(value) {
  const core = value.replace(/[.,;:]+$/u, '');
  const tail = value.slice(core.length);
  const word = core.toLowerCase().replace(/^[("'“‘]+|[)"'”’]+$/gu, '').replace(/['’]/g, '');
  const secretLooking = core === '[link removed]' || /^["'“‘«`]/.test(core) || /\p{Nd}/u.test(core) || /[@#$%^&*!_+=~\\|<>]/.test(core) || /\p{Ll}\p{Lu}/u.test(core);
  return { core, tail, hasValue: /[\p{L}\p{N}]/u.test(core), stop: PW_STOP.has(word), keyword: RULE_KEYWORD_WORD.test(word), secretLooking };
}
const pwStopWord = (token) => PW_STOP.has(token.toLowerCase().replace(/[.,;!?]+$/u, '').replace(/['’]/g, '').replace(/^-+|-+$/g, ''));

/** For the text after the colon of reading (1): where (an offset in `phrase`) the masking stops, or -1 when the phrase is a status note. */
function passphraseEnd(phrase) {
  const cut = phrase.search(ANY_KEYWORD);                            // never read past the keyword of another rule or another password word
  const text = cut >= 0 ? phrase.slice(0, cut) : phrase;
  const toks = [...text.matchAll(PW_WORD_G)];
  let n = toks.length;
  for (let k = 0; k < toks.length; k++) if (/[.,;!?]$/.test(toks[k][0])) { n = k + 1; break; }
  const clause = toks.slice(0, n);
  if (!clause.length || !pwStopWord(clause[0][0])) return -1;        // a first word that is not an everyday word: the rule below masks it
  let stops = 0;
  let others = 0;
  let last = -1;
  clause.forEach((t, k) => { if (pwStopWord(t[0])) stops++; else { others++; last = k; } });
  if (others < 2 || others <= stops) return -1;                      // a short status note ("not working on portal"), not a passphrase
  return clause[last].index + clause[last][0].replace(/[.,;!?]+$/u, '').length;
}
function maskPasswordPhrases(s) {
  let out = '';
  let at = 0;
  PW_PHRASE_RE.lastIndex = 0;
  let m;
  while ((m = PW_PHRASE_RE.exec(s)) !== null) {
    const keywordEnd = m.index + m[1].length;
    const end = passphraseEnd(m[3]);
    if (end < 0) { PW_PHRASE_RE.lastIndex = keywordEnd; continue; }   // read on from just after the keyword: a second password word inside this match gets its own turn
    const valueStart = keywordEnd + m[2].length;
    out += s.slice(at, valueStart) + MASK_TEXT;
    at = valueStart + end;
    PW_PHRASE_RE.lastIndex = at;
  }
  return out + s.slice(at);
}
/** After the end of a masked value: the end of the run of further password-like values joined to it ("/", a comma, "and" ...), at most three more. */
function passwordListEnd(s, end) {
  let pos = end;
  for (let k = 0; k < 3; k++) {
    PW_NEXT.lastIndex = pos;
    const sep = PW_NEXT.exec(s);
    if (!sep) break;
    PW_VALUE_AT.lastIndex = pos + sep[0].length;
    const val = PW_VALUE_AT.exec(s);
    if (!val || val[0].startsWith(MASK_TEXT)) break;
    const v = pwValue(val[0]);
    // a letter and a digit, symbol or inner capital: a pure number or a plain word after the list separator is not taken
    if (!v.hasValue || v.stop || v.keyword || !v.secretLooking || !/\p{L}/u.test(v.core) || PW_EMAIL.test(v.core)) break;
    pos = val.index + v.core.length;
  }
  return pos;
}
/** After a keyword ending at `from`: the first value (start, end) that a filler-word reading says is a password, or null. */
function passwordFillerValue(s, from) {
  let pos = from;
  for (let k = 0; k <= 6; k++) {
    if (k > 0) {
      PW_FILLER_WORD.lastIndex = pos;
      const w = PW_FILLER_WORD.exec(s);
      if (!w) return null;
      pos += w[0].length;
    }
    PW_CONNECTOR.lastIndex = pos;
    const c = PW_CONNECTOR.exec(s);
    if (!c) continue;
    const weak = c[3] !== undefined;
    if (k === 0 && !weak) continue;                                  // straight after the keyword the colon and "is" forms belong to reading (3)
    if (k > 4 && !weak) continue;                                    // up to four filler words, six before "to" / "be" / "as" / "now"
    PW_VALUE_AT.lastIndex = pos + c[0].length;
    const val = PW_VALUE_AT.exec(s);
    if (!val || val[0].startsWith(MASK_TEXT)) continue;
    const v = pwValue(val[0]);
    if (!v.hasValue || v.stop || v.keyword || PW_EMAIL.test(v.core)) continue;   // an e-mail address after "password reset sent to:" is not a password
    if (weak && !v.secretLooking) continue;                          // "password reset to tenant": only a secret-looking value after "to"
    return { start: val.index, end: passwordListEnd(s, val.index + v.core.length) };
  }
  return null;
}
function maskPasswordFillers(s) {
  let out = '';
  let at = 0;
  PW_KEYWORD_G.lastIndex = 0;
  let m;
  while ((m = PW_KEYWORD_G.exec(s)) !== null) {
    const hit = passwordFillerValue(s, m.index + m[0].length);
    if (!hit || hit.start < at) continue;
    out += s.slice(at, hit.start) + MASK_TEXT;
    at = hit.end;
    PW_KEYWORD_G.lastIndex = Math.max(PW_KEYWORD_G.lastIndex, hit.end);
  }
  return out + s.slice(at);
}
function maskPasswordsRight(s) {
  let out = '';
  let at = 0;
  PASSWORD_RE.lastIndex = 0;
  let m;
  while ((m = PASSWORD_RE.exec(s)) !== null) {
    const [, kw, sep, value] = m;
    if (value.startsWith(MASK_TEXT)) continue;                      // already masked: the mask is idempotent
    const v = pwValue(value);
    if (!v.hasValue) continue;                                      // only punctuation: there is no value
    const assigned = /[:=>]/.test(sep) || /(?:^|\s)(?:is|es|are|was|era|son)(?![\p{L}\p{N}])/iu.test(sep);
    if (v.stop || v.keyword) continue;                              // an everyday word, or the keyword of another rule, is not a password
    if (!assigned && !v.secretLooking) continue;
    const start = m.index + kw.length + sep.length;
    out += s.slice(at, start) + MASK_TEXT;
    at = passwordListEnd(s, start + v.core.length);
    PASSWORD_RE.lastIndex = Math.max(PASSWORD_RE.lastIndex, at);
  }
  return out + s.slice(at);
}
function maskPasswords(s) { return maskPasswordsRight(maskPasswordFillers(maskPasswordPhrases(s))); }

// A separated Social Security number (###-##-####, dashes or spaces) and a payment card number on its own (no card word in front of
// it), in ONE pass over each run of digits (digits with at most one space or dash between any two), so that neither rule can cut
// the other: the spans of both are united and every group that touches a span is replaced with it, whichever comes first
// ("123-45-6789 4111 1111 1111 1111", "4111 1111 1111 1111 123-45-6789" and "123-45-6789 4521 4522 4523 4524" leave no digit of the
// SSN or the card). A Social Security number is three groups of 3, 2 and 4 digits. The card readings are run on the whole run (a
// card that contains an SSN-shaped stretch is masked whole) and again on the stretches between the SSNs (an SSN beside a card must
// not use up the card's window). Two readings of a run for a card, each needing a valid check digit (Luhn) and 13 to 19 digits:
//  1. The old content screen's own card test (kept in step with it by mask-tests.js C2): the run is read from its start, one
//     longest window of 13 to 19 digits (ending at the end of a group) at a time, whatever the grouping; when a window fails the
//     check digit the next window starts after it. A list of ordinary numbers (unit numbers, tickets, a phone number and an
//     extension) is masked no more often than the check digit's own 1 in 10 for a single number.
//  2. A number written the way cards are written (one group of 13 to 19 digits, 4-4-4-1 to 4-4-4-4-3, or the American Express
//     4-6-5), wherever it starts inside a longer run, so a card number written straight after another number ("apt 12 4111 1111
//     1111 1111") is found. A group of four 4-digit numbers is NOT masked just because its first digits look like a card prefix:
//     the check digit must pass (unit and ticket numbers stay). The price is a second chance for the check digit to pass by luck
//     in a long list of 4-digit numbers (the SPEC gives the measured rates).
const DIGIT_RUN = new RegExp(`(?<!\\p{Nd})\\p{Nd}(?:${SEP}?\\p{Nd})*(?!\\p{Nd})`, 'gu');

function isCardLayout(groups, i, j) {
  if (i === j) return true;
  const lens = [];
  for (let k = i; k <= j; k++) lens.push(groups[k].digits.length);
  const last = lens[lens.length - 1];
  const fourFourFour = lens.length >= 4 && lens.slice(0, -1).every((n) => n === 4) && last >= 1 && last <= 4;     // 4-4-4-1 ... 4-4-4-4, 4-4-4-4-3
  const amex = lens.length === 3 && lens[0] === 4 && lens[1] === 6 && lens[2] === 5;
  return fourFourFour || amex;
}

/** The windows (first group, last group) of a run that are card numbers. */
function cardWindows(groups) {
  const hits = [];
  let i = 0;
  while (i < groups.length) {
    let total = 0;
    let best = -1;
    let digits = '';
    let bestDigits = '';
    for (let j = i; j < groups.length; j++) {
      total += groups[j].digits.length;
      digits += groups[j].digits;
      if (total > 19) break;
      if (total >= 13) { best = j; bestDigits = digits; }
    }
    if (best >= 0) {
      if (luhnOk(bestDigits)) hits.push([i, best]);
      i = best + 1;
    } else i++;
  }
  for (let a = 0; a < groups.length; a++) {
    let total = 0;
    let digits = '';
    let found = -1;
    for (let j = a; j < groups.length; j++) {
      total += groups[j].digits.length;
      digits += groups[j].digits;
      if (total > 19) break;
      if (total >= 13 && isCardLayout(groups, a, j) && luhnOk(digits)) found = j;
    }
    if (found >= 0) hits.push([a, found]);
  }
  return hits;
}

/** The spans (first group, last group) of the Social Security shapes in a run: three groups of 3, 2 and 4 digits. */
function socialSpans(groups) {
  const spans = [];
  for (let a = 0; a + 2 < groups.length; a++) {
    if (groups[a].digits.length === 3 && groups[a + 1].digits.length === 2 && groups[a + 2].digits.length === 4) { spans.push([a, a + 2]); a += 2; }
  }
  return spans;
}

/** The last group of the longest window of 13 to 19 digits that starts at group p and stops before group q, when its digits pass the check digit; -1 otherwise. */
function windowFrom(groups, p, q) {
  let total = 0;
  let digits = '';
  let best = -1;
  let bestDigits = '';
  for (let j = p; j < q; j++) {
    total += groups[j].digits.length;
    digits += groups[j].digits;
    if (total > 19) break;
    if (total >= 13) { best = j; bestDigits = digits; }
  }
  return best >= 0 && luhnOk(bestDigits) ? best : -1;
}

function maskCardRun(run) {
  const groups = [];
  const re = /\p{Nd}+/gu;
  let g;
  while ((g = re.exec(run)) !== null) groups.push({ start: g.index, end: g.index + g[0].length, digits: digitsOf(g[0]) });
  const raw = cardWindows(groups);
  const social = socialSpans(groups);
  if (social.length) {
    // Beside a Social Security number the card readings are repeated with the SSN left out and with it taken in: a card may start
    // at the run's start or right after an SSN, and may stop at the run's end or right before an SSN, and an SSN-shaped stretch
    // inside the card is then part of it.
    const starts = [0, ...social.map(([, b]) => b + 1)].filter((x) => x < groups.length);
    const stops = [...social.map(([a]) => a), groups.length];
    let q = 0;
    for (const p of starts) {
      while (q < stops.length && stops[q] <= p) q++;
      for (let k = q; k < stops.length && stops[k] - p <= 19; k++) {
        const j = windowFrom(groups, p, stops[k]);
        if (j >= 0) raw.push([p, j]);
      }
    }
    let from = 0;
    for (const [a, b] of [...social, [groups.length, groups.length]]) {
      if (a > from) for (const [x, y] of cardWindows(groups.slice(from, a))) raw.push([x + from, y + from]);
      from = b + 1;
    }
    raw.push(...social);
  }
  if (!raw.length) return run;
  raw.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const hits = [];
  for (const h of raw) {
    const prev = hits[hits.length - 1];
    if (prev && h[0] <= prev[1]) prev[1] = Math.max(prev[1], h[1]);
    else hits.push([h[0], h[1]]);
  }
  let out = '';
  let at = 0;
  for (const [a, b] of hits) {
    out += run.slice(at, groups[a].start) + MASK_TEXT;
    at = groups[b].end;
  }
  return out + run.slice(at);
}
function maskCardsAndSocial(s) { return s.replace(DIGIT_RUN, (run) => maskCardRun(run)); }

/**
 * A BEST EFFORT, not a guarantee: replaces, with "[removed]", the known shapes of the
 * strings that must never be written into an inbox under Peter's standing rule (no SSNs,
 * bank account numbers or passwords): a Social Security number, a payment card number
 * (and its security code), a bank account, routing, IBAN or SWIFT number introduced by
 * its word, and a password-like secret introduced by "password", "passcode", "pwd" or
 * "contrasena". A REPLACEMENT, never a hold: the rest of the text is shown. Pure and
 * synchronous, no logging. The order matters (see the SPEC): the rules that need a keyword
 * run before the password rules, the IBAN rule after them, and the separated SSN and the
 * card number are ONE pass, so neither can cut the other. On its own it is stable for
 * ordinary text; cleanTextUnscreened repeats it until the text no longer changes, so what
 * is printed is a fixed point. What it does NOT catch is listed in the SPEC (an account
 * number with no keyword, a card number in an unusual grouping written straight after
 * another number, a password with no separator, other-language words, look-alike letters ...).
 * @param {string} s - already cleaned text
 */
function maskNeverStore(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = maskSocialByWord(s);
  out = maskAccountNumbers(out);
  out = maskCardsByWord(out);
  out = maskSecurityCodes(out);
  out = maskSwiftCodes(out);
  out = maskPasswords(out);
  out = maskIbans(out);
  return maskCardsAndSocial(out);
}

/**
 * The text that is printed when the content screen is off: the ordinary cleaning
 * (cleanText), then the never-store mask, then a link that exists only in the NFKC
 * reading (the Spanish ordinal marks are kept as typed but fold to letters) is
 * neutralised instead of held, and the three are repeated until nothing changes
 * (so the result is both clean and masked, and neither step can undo the other).
 * No text is held here: a web-like token becomes "[link removed]" and the rest is
 * shown.
 * @param {string|null|undefined} value
 * @returns {string} '' for null, undefined or nothing left.
 * @throws {CleanError} (constant code, never the text) for a value that is not text or
 *   input that will not settle.
 */
function cleanTextUnscreened(value) {
  if (value === null || value === undefined) return '';
  let cur = cleanText(value);
  for (let i = 0; i < 5; i++) {
    let next = maskNeverStore(cur);
    if (hasFoldedLink(next)) next = neutraliseLinks(next.normalize('NFKC'));
    next = cleanText(next);
    if (next === cur && !hasFoldedLink(cur)) return cur;
    cur = next;
  }
  throw new CleanError('clean_did_not_settle');
}

module.exports = {
  cleanText,
  cleanTextBoth,
  cleanTextUnscreened,
  maskNeverStore,
  luhnOk,
  MASK_TEXT,
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
