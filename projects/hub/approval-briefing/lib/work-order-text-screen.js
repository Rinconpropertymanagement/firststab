/**
 * lib/work-order-text-screen.js
 *
 * The local screen that decides whether a Latchel work order's title and
 * description may be quoted in the Work Order Alert email. It is a word-list
 * scan that runs on this server and nowhere else. NO MODEL IS CALLED, NOTHING
 * IS SENT ANYWHERE, and nothing here can reach the network: this file has no
 * I/O at all.
 *
 *   screenWorkOrderText({ title, description, spaced?, symbols?, both? })
 *     -> { status: 'cleared' | 'held',
 *          cause: null | 'local_screen' | 'check_error',
 *          categories: [names from the fixed vocabulary only],
 *          common_word_only: boolean,
 *          screen_version }
 *
 * It is synchronous and side-effect-free, and it never throws.
 *
 * ANY match of ANY term is a HOLD, including the ordinary words white, black,
 * blind, diagnosis, diagnosed, too old and too young for. There is no rescue,
 * no allow-list and no per-instance exception in this build. A hold costs one
 * sentence ("open the Latchel job"); a miss is the real risk.
 *
 * WHAT IT READS. The same cleaned strings that would be displayed (checked
 * equals shown), whole length up to the cleaner's cap, title and description
 * joined by one space. Two folded copies are made:
 *   shared copy  NFKC, lowercase, accents stripped (n-tilde reads as n,
 *                e-acute as e), curly apostrophes made straight, any decimal
 *                digit of any script turned into 0-9. Hyphens are kept.
 *                maintenance-history/lib/protected-class-terms.js scanText()
 *                runs on this copy (read-only use of that file).
 *   local copy   the shared copy with hyphens, dashes, underscores, slashes,
 *                periods and apostrophes turned into spaces. The feature-local
 *                lists in work-order-text-screen-terms.js run on this copy as
 *                whole words and phrases, never as bare substrings (they read
 *                it as words, so any other punctuation between words is
 *                already a separator for them). The slur check reads this copy.
 *   word copy    the words of the text (runs of letters and digits) joined by
 *                single spaces: EVERY other character, whatever it is (comma,
 *                colon, plus, pipe, brackets, a bullet, an arrow ...), counts
 *                as one space. The shared scanText() runs on the shared copy
 *                (so a term that has punctuation of its own still matches) AND
 *                on this one, so a phrase of the shared list is held whatever
 *                punctuation stands where its space belongs. The "N day notice"
 *                patterns read this copy. (It contains everything the local
 *                copy would give the shared list, so the shared list is not
 *                run on the local copy as well.)
 *   squashed     the words joined with no separator at all. A short fixed list
 *                of long two-word protected phrases (SQUASHED_PHRASES in the
 *                terms file, each at least nine letters) is looked for in it,
 *                so such a phrase typed as one word, or glued by invisible
 *                characters inside and between its words, is still held. No
 *                general substring matching.
 *
 * THE OTHER READINGS. The cleaner REMOVES invisible characters and tags, which
 * glues the words on either side together ("domestic<invisible>violence" is
 * "domesticviolence" in the displayed text), and its NFKC step turns a symbol
 * such as the numero sign into LETTERS that glue the words on either side. It
 * therefore also hands over the same text read the other ways: `spaced` (each
 * removed piece became a space), `symbols` (each symbol that NFKC would turn
 * into letters became a space) and `both`, each as { title, description }.
 * Everything below runs on the displayed reading and on each of these, and any
 * one of them holds. The displayed text is never changed by this. (`symbols`
 * and `both` are read for phrases only: the script, look-alike, pictograph and
 * unfamiliar-language rules read the displayed text and the spaced reading, so
 * a reading that differs only by spaces cannot add a false alarm of those
 * kinds.)
 *
 * THE TYPED-SYMBOL READING (R4-1). The screen also makes this reading itself,
 * from every reading it is given, by turning each symbol that NFKC would turn
 * into letters (the trademark and service-mark signs, the ordinal marks, which
 * the cleaner leaves as typed, and the like) and nothing else into a space, and
 * the section sign into the word "section" (so "section sign 8" is Section 8).
 * Digit-like marks (superscripts, fractions, circled digits) are NOT changed,
 * so they keep reading as digits for the notice and Social Security patterns.
 * The phrase scans below (shared list, feature lists, Section 8 rule, squashed
 * phrases, slurs, "N day notice", financial patterns) run on that reading too.
 *
 * ALSO HELD (all categories are recorded by name only):
 *   - unscreenable_language: 3 or more letters (or more than 10 percent of the
 *     letters) outside the Latin script; a single word that mixes Latin and
 *     non-Latin letters (look-alike tricks); any Latin-script letter that is
 *     still not plain A-Z after folding (dotless i, stroke and phonetic
 *     letters, small capitals, sharp s, and so on); and 8 or more words of
 *     which fewer than 15 percent are very common English or Spanish words
 *     (text in a language the lists cannot read, such as Tagalog or
 *     Vietnamese). The last rule is applied to the whole text, to the
 *     description alone and to the title alone, so an English title cannot
 *     dilute a description in another language.
 *   - meaning-bearing symbols: a short list of pictographs (wheelchair
 *     symbol, pregnancy, rainbow flag base, houses of worship, police,
 *     ambulance, coffin and similar), skin-tone modifiers and country-flag
 *     letters. Any other emoji passes (accepted residual risk).
 *   - "N day notice" in its common written forms (digits or number words to
 *     ninety-nine and hundred, glued "3day", business / calendar / court /
 *     working days, "days of notice", "notice of N days", "(N) day", with
 *     "written", "to quit / vacate / pay / perform / cure", hour-based only when
 *     followed by one of those) and the Spanish forms (aviso / notificacion de N
 *     dias, N dias de aviso, in digits or words). Hour-based entry notices are
 *     not held.
 *   - the Section 8 rule: "section", "sec" or "seccion" with 8, eight, viii or
 *     ocho within two words after it.
 *   - financial_id: a separated SSN (###-##-####), a card number that passes
 *     the Luhn check, and credential or ID words (ssn, routing number, ...).
 *     NOT held, by the owner's written decision: phone numbers, e-mail
 *     addresses, unit numbers and gate, lockbox and alarm codes.
 *   - slurs, with light obfuscation tolerance (repeated letters and the
 *     substitutions @ $ 0 1), kept in the terms file only.
 *
 * FAILS CLOSED. Anything that is not a string, any exception, a blown time
 * budget, or a failed start-up self-test returns held with cause
 * 'check_error' for every call. The alert is still sent.
 *
 * Governance record: compliance/work-order-note-alerts-description-governance-review.md
 * (Asimov's re-ruling) and compliance/work-order-note-alerts-description-decision-resolution.md
 * (Peter's decisions). Spec: work-order-notes-alert-SPEC.md Section 6A.
 *
 * NEVER LOG OR RETURN THE TEXT, A MATCHED WORD OR A COUNT PER WORD. The only
 * output derived from the text is: held or cleared, a category name from the
 * fixed vocabulary, and one yes/no (common_word_only).
 */

'use strict';

const { scanText, TERMS_VERSION } = require('../../maintenance-history/lib/protected-class-terms');
const T = require('./work-order-text-screen-terms');
const { symbolsToSpaces } = require('./work-order-text-clean');

const SCREEN_VERSION = `${TERMS_VERSION}+${T.WO_SUPP_VERSION}`;
const VOCABULARY = T.CATEGORY_VOCABULARY;
const VOCAB_SET = new Set(VOCABULARY);

// Wall-clock budget for one call. A check between stages (JavaScript cannot
// interrupt a regular expression); the patterns are linear, this is the
// belt-and-braces that makes a surprise slow path fail closed.
let BUDGET_MS = 1500;

// ─── Folding ────────────────────────────────────────────────────────────────
// Includes \p{Cn} (unassigned code points and noncharacters such as U+FFFF).
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\u2800\uFFFC]/gu;
const DECIMAL_DIGIT = /\p{Nd}/gu;
const DECIMAL_DIGIT_ONE = /\p{Nd}/u;

// Any decimal digit (Arabic-Indic, Devanagari, Thai ...) becomes 0-9, so the
// SSN, card and notice patterns cannot be dodged by the digit shapes. Decimal
// digits come in unbroken runs of ten starting at the zero.
function asciiDigits(s) {
  if (!/[^\x00-\x7F]/.test(s)) return s;
  return s.replace(DECIMAL_DIGIT, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp >= 0x30 && cp <= 0x39) return ch;
    let zero = cp;
    while (zero > 0 && DECIMAL_DIGIT_ONE.test(String.fromCodePoint(zero - 1))) zero--;
    return String((cp - zero) % 10);
  });
}

function foldShared(text) {
  let s = text.normalize('NFKC');
  // The cleaner already removed these. Removed again so the screen is safe on
  // its own: an invisible character must never split a keyword.
  s = s.replace(INVISIBLE, '');
  s = asciiDigits(s);
  s = s.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  return s.replace(/[\u2018\u2019\u201B\u02BC\u2032\u00B4`]/g, "'");
}

function foldLocal(sharedCopy) {
  return sharedCopy.replace(/['\u2010-\u2015\u2212_/\\.\-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The typed-symbol reading of a text (see THE TYPED-SYMBOL READING above).
function typedWordsText(text) {
  let t = symbolsToSpaces(text);
  if (t.includes('\u00A7')) t = t.replace(/\u00A7/g, ' section ');
  return t;
}

const WORD_TOKEN = /[\p{L}\p{N}]+/gu;
const SLUR_TOKEN = /[\p{L}\p{N}@$]+/gu;

// ─── Compile the feature-local lists ────────────────────────────────────────
const exactIndex = new Map();   // first word -> entries
const stemIndex = new Map();    // stem length -> Map(prefix -> entries)
const pairRules = [];
const slurSet = new Set();
const squashed = [];                   // { text, cat }: long two-word phrases looked for with every separator removed
const slurCollapsedSet = new Set();
const symbolByCodePoint = new Map();   // code point -> category name
const symbolRanges = [];               // { from, to, cat }
let lowestSymbol = 0x110000;
let termCount = 0;
let compileProblem = null;

function collapseAll(s) { return s.replace(/(.)\1+/gu, '$1'); }

// A letter repeated 3 or more times may have been written once or twice
// (the token "aaabbb" could stand for "ab", "aab" or "abb"), so every long run is tried both
// ways. A token with more than 4 long runs is not a word: only the two
// all-runs variants are tried, which keeps the work linear.
function elongationVariants(token) {
  const parts = [];
  const re = /(.)\1{2,}/gu;
  let last = 0;
  let m;
  while ((m = re.exec(token)) !== null) {
    if (m.index > last) parts.push([token.slice(last, m.index)]);
    parts.push([m[1], m[1] + m[1]]);
    last = m.index + m[0].length;
  }
  if (!parts.length) return [token];
  if (last < token.length) parts.push([token.slice(last)]);
  if (parts.filter((p) => p.length === 2).length > 4) {
    return [token.replace(/(.)\1{2,}/gu, '$1'), token.replace(/(.)\1{2,}/gu, '$1$1')];
  }
  let out = [''];
  for (const p of parts) {
    const next = [];
    for (const o of out) for (const c of p) next.push(o + c);
    out = next;
  }
  return out;
}

function compile() {
  for (const [cat, entries] of Object.entries(T.TERMS)) {
    if (!VOCAB_SET.has(cat)) throw new Error('terms_unknown_category');
    for (const { term, common } of entries) {
      // Stored already folded: folding must not change it.
      if (foldLocal(foldShared(term)) !== term) throw new Error('terms_not_folded');
      if (!/^[a-z0-9]+\*?(?: [a-z0-9]+\*?)*$/.test(term)) throw new Error('terms_bad_shape');
      const toks = term.split(' ').map((w) => {
        const stem = w.endsWith('*');
        const t = stem ? w.slice(0, -1) : w;
        if (stem && !/^[a-z]{5,}$/.test(t)) throw new Error('terms_short_stem');
        return { t, stem };
      });
      const entry = { cat, toks, common: !!common };
      const first = toks[0];
      if (first.stem) {
        const len = first.t.length;
        if (!stemIndex.has(len)) stemIndex.set(len, new Map());
        const m = stemIndex.get(len);
        if (!m.has(first.t)) m.set(first.t, []);
        m.get(first.t).push(entry);
      } else {
        if (!exactIndex.has(first.t)) exactIndex.set(first.t, []);
        exactIndex.get(first.t).push(entry);
      }
      termCount++;
    }
  }
  for (const rule of T.PAIR_RULES) {
    if (!VOCAB_SET.has(rule.cat)) throw new Error('terms_unknown_category');
    for (const w of [...rule.a, ...rule.b]) {
      if (foldLocal(foldShared(w)) !== w || /[ *]/.test(w)) throw new Error('terms_bad_pair_word');
    }
    pairRules.push({ cat: rule.cat, a: new Set(rule.a), b: new Set(rule.b), window: rule.window, order: rule.order });
  }
  for (const sym of T.SYMBOLS) {
    if (!VOCAB_SET.has(sym.cat)) throw new Error('terms_unknown_category');
    for (const cp of sym.cps || []) {
      if (!Number.isInteger(cp) || cp < 0x2000 || cp > 0x10FFFF) throw new Error('terms_bad_symbol');
      symbolByCodePoint.set(cp, sym.cat);
      lowestSymbol = Math.min(lowestSymbol, cp);
    }
    for (const [from, to] of sym.ranges || []) {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0x2000 || to < from || to > 0x10FFFF) throw new Error('terms_bad_symbol');
      symbolRanges.push({ from, to, cat: sym.cat });
      lowestSymbol = Math.min(lowestSymbol, from);
    }
  }
  for (const { phrase, cat } of T.SQUASHED_PHRASES) {
    if (!VOCAB_SET.has(cat)) throw new Error('terms_unknown_category');
    const text = phrase.replace(/ /g, '');
    // Two words and at least nine letters in all, letters only. (A test proves each one is a phrase that is really on the shared or the local list.)
    if (phrase.split(' ').length !== 2 || !/^[a-z]{9,}$/.test(text)) throw new Error('terms_bad_squashed');
    squashed.push({ text, cat });
  }
  for (const s of T.SLURS) {
    slurSet.add(s.toLowerCase());
    const flat = collapseAll(s.toLowerCase());
    if (flat.length >= 5) slurCollapsedSet.add(flat);
  }
}

try { compile(); } catch (_err) { compileProblem = 'compile_failed'; }

// ─── Matching ───────────────────────────────────────────────────────────────
function entryMatchesAt(entry, tokens, i) {
  const toks = entry.toks;
  if (i + toks.length > tokens.length) return false;
  for (let k = 0; k < toks.length; k++) {
    const want = toks[k];
    const have = tokens[i + k];
    if (want.stem ? !have.startsWith(want.t) : have !== want.t) return false;
  }
  return true;
}

function scanTerms(tokens, hit) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const exact = exactIndex.get(tok);
    if (exact) {
      for (const e of exact) if (entryMatchesAt(e, tokens, i)) hit(e.cat, e.common);
    }
    for (const [len, byPrefix] of stemIndex) {
      if (tok.length < len) continue;
      const list = byPrefix.get(tok.slice(0, len));
      if (list) for (const e of list) if (entryMatchesAt(e, tokens, i)) hit(e.cat, e.common);
    }
  }
}

function scanPairs(tokens, hit) {
  const n = tokens.length;
  for (const rule of pairRules) {
    const cumA = new Int32Array(n + 1);
    const cumB = new Int32Array(n + 1);
    let anyB = false;
    for (let i = 0; i < n; i++) {
      const inA = rule.a.has(tokens[i]) ? 1 : 0;
      const inB = rule.b.has(tokens[i]) ? 1 : 0;
      if (inB) anyB = true;
      cumA[i + 1] = cumA[i] + inA;
      cumB[i + 1] = cumB[i] + inB;
    }
    if (!anyB || cumA[n] === 0) continue;
    for (let i = 0; i < n; i++) {
      if (!rule.b.has(tokens[i])) continue;
      const selfA = rule.a.has(tokens[i]) ? 1 : 0;
      const lo = Math.max(0, i - rule.window);
      let count;
      if (rule.order === 'a_before_b') {
        count = cumA[i] - cumA[lo];
      } else {
        const hi = Math.min(n, i + rule.window + 1);
        count = cumA[hi] - cumA[lo] - selfA;
      }
      if (count > 0) { hit(rule.cat, false); break; }
    }
  }
}

function scanSlurs(localCopy, hit) {
  const raw = localCopy.match(SLUR_TOKEN);
  if (!raw) return;
  for (const t of raw) {
    if (!/\p{L}/u.test(t)) continue;
    const swapped = t.replace(/@/g, 'a').replace(/\$/g, 's').replace(/0/g, 'o').replace(/1/g, 'i');
    // The word itself, and the word with a plural -s or -es taken off ("<slur>s", "<slur>es").
    const forms = [swapped];
    if (swapped.length > 3 && swapped.endsWith('es')) forms.push(swapped.slice(0, -2));
    if (swapped.length > 3 && swapped.endsWith('s')) forms.push(swapped.slice(0, -1));
    if (forms.some((f) => elongationVariants(f).some((v) => slurSet.has(v)) || slurCollapsedSet.has(collapseAll(f)))) {
      hit('religion_identity', false);
      return;
    }
  }
}

const SSN_PATTERN = /(?<!\d)\d{3}[- ]\d{2}[- ]\d{4}(?!\d)/;
const CARD_PATTERN = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

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

function scanFinancialPatterns(sharedCopy, hit) {
  const t = sharedCopy.replace(/[\u2010-\u2015\u2212]/g, '-');
  if (SSN_PATTERN.test(t)) hit('financial_id', false);
  for (const m of t.matchAll(CARD_PATTERN)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnOk(digits)) { hit('financial_id', false); return; }
  }
}

// "section" / "sec" / "seccion" with 8, eight, viii or ocho within two words
// after it: the Section 8 voucher however the "8" is punctuated or spelled.
const SECTION_WORDS = new Set(['section', 'sec', 'seccion']);
const EIGHT_WORDS = new Set(['8', 'eight', 'viii', 'ocho']);

function scanSectionEight(tokens, hit) {
  for (let i = 0; i < tokens.length; i++) {
    if (!SECTION_WORDS.has(tokens[i])) continue;
    if (EIGHT_WORDS.has(tokens[i + 1]) || EIGHT_WORDS.has(tokens[i + 2])) { hit('source_of_income', false); return; }
  }
}

function scanSquashed(tokens, hit) {
  const flat = tokens.join('');
  if (flat.length < 9) return;
  for (const { text, cat } of squashed) if (flat.includes(text)) hit(cat, false);
}

// "N day notice" in its common written forms, English and Spanish. Run on the
// word copy (every other character is one space), so "3-day", "(3) day",
// "30 days' notice" and "notice: 3 days" all read as plain words.
// Hour-based notices are NOT held unless they end in to quit / vacate / pay /
// perform / cure (a 24 hour notice of entry is an ordinary notice).
const UNITS_EN = 'one|two|three|four|five|six|seven|eight|nine';
const TEENS_EN = 'ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const TENS_EN = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const NUM_EN = `(?:\\d{1,3}|one hundred|a hundred|hundred|(?:${TENS_EN})(?: (?:${UNITS_EN}))?|${TEENS_EN}|${UNITS_EN})`;
const QUAL_EN = '(?:(?:business|calendar|court|working) )?';
const CURE_EN = 'to (?:quit|vacate|pay|perform|cure)';
const UNITS_ES = 'un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve';
const TEENS_ES = 'diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve';
const TENS_ES = 'veinte|veintiun|veintiuno|veintidos|veintitres|veinticuatro|veinticinco|veintiseis|veintisiete|veintiocho|veintinueve|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa';
const NUM_ES = `(?:\\d{1,3}|cien|ciento|(?:${TENS_ES})(?: y (?:${UNITS_ES}))?|${TEENS_ES}|${UNITS_ES})`;
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const NOTICE_PATTERNS = [
  // 3 day notice, 3day notice, three business days notice, 30 days written notice, 3 day notice to quit, 5 days to vacate
  new RegExp(`${B}${NUM_EN} ?${QUAL_EN}days? (?:written )?(?:notices?|${CURE_EN})${E}`, 'u'),
  // 72 hour notice to quit (but not 24 hour notice of entry)
  new RegExp(`${B}${NUM_EN} ?${QUAL_EN}hours? (?:written )?(?:notices? )?${CURE_EN}${E}`, 'u'),
  // 3 days of notice
  new RegExp(`${B}${NUM_EN} ?${QUAL_EN}days? of (?:written )?notices?${E}`, 'u'),
  // notice of 3 days, notice (3 days), notice: 3 days, notice for at least 30 days
  new RegExp(`${B}notices? (?:(?:of|for|is) )?(?:(?:at least|a minimum of|minimum of) )?${NUM_EN} ?${QUAL_EN}days?${E}`, 'u'),
  // aviso de 7 dias, aviso 3 dias, aviso de tres (3) dias, notificacion de 30 dias habiles
  new RegExp(`${B}(?:avisos?|notificacion|notificaciones)(?: de| por)? ${NUM_ES}(?: ${NUM_ES})? dias?${E}`, 'u'),
  // 3 dias de aviso, tres (3) dias habiles de notificacion
  new RegExp(`${B}${NUM_ES}(?: ${NUM_ES})? dias?(?: (?:habiles|calendario|naturales|corridos))? de (?:avisos?|notificacion|notificaciones)${E}`, 'u'),
];

function scanNoticePatterns(words, hit) {
  for (const re of NOTICE_PATTERNS) if (re.test(words)) { hit('legal_eviction', false); return; }
}

// A Latin-script letter that is still not plain A-Z after folding (dotless i,
// stroke letters, small capitals, sharp s ...). Spanish accents are already
// folded away, so ordinary Spanish does not trigger this.
const NON_ASCII_LATIN = /(?=\p{Script=Latin})[^\x00-\x7F]/u;

function scanLookalikeLatin(sharedCopy, hit) {
  if (NON_ASCII_LATIN.test(sharedCopy)) hit('unscreenable_language', false);
}

// The short list of meaning-bearing symbols (see the terms file).
function scanSymbols(sharedCopy, hit) {
  for (const ch of sharedCopy) {
    const cp = ch.codePointAt(0);
    if (cp < lowestSymbol) continue;
    let cat = symbolByCodePoint.get(cp);
    if (!cat) for (const r of symbolRanges) if (cp >= r.from && cp <= r.to) { cat = r.cat; break; }
    if (cat) hit(cat, false);
  }
}

const NOT_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/gu;
const NOT_LATIN_ONE = /(?!\p{Script=Latin})\p{L}/u;
const LATIN_ONE = /\p{Script=Latin}/u;

function scanScripts(sharedCopy, hit) {
  const letters = sharedCopy.match(/\p{L}/gu);
  const total = letters ? letters.length : 0;
  if (!total) return;
  const nonLatin = (sharedCopy.match(NOT_LATIN_LETTER) || []).length;
  if (nonLatin >= 3 || nonLatin / total > 0.10) { hit('unscreenable_language', false); return; }
  if (nonLatin > 0) {
    // A word that mixes Latin and non-Latin letters is a look-alike trick
    // (a Cyrillic letter inside a Latin word), which the folding cannot undo.
    for (const tok of sharedCopy.match(WORD_TOKEN) || []) {
      if (LATIN_ONE.test(tok) && NOT_LATIN_ONE.test(tok)) { hit('unscreenable_language', false); return; }
    }
  }
}

function scanUnrecognisedLanguage(tokens, hit) {
  let words = 0;
  let known = 0;
  for (const t of tokens) {
    if (!/\p{L}/u.test(t)) continue;
    words++;
    if (T.COMMON_WORDS.has(t)) known++;
  }
  if (words >= 8 && known / words < 0.15) hit('unscreenable_language', false);
}

function overBudget(started) {
  return Number(process.hrtime.bigint() - started) / 1e6 > BUDGET_MS;
}

/**
 * The scan itself. `reading` is { title, description } (cleaned strings);
 * `extras` is a list of { reading, full } for the other readings (see THE OTHER
 * READINGS): `full` readings get every rule, the others the phrase scans only.
 * Returns { categories:Set, common:boolean } or throws.
 */
function analyze(reading, extras) {
  const started = process.hrtime.bigint();
  const cats = new Set();
  let sawAny = false;
  let allCommon = true;
  const hit = (cat, common) => {
    if (cat) cats.add(cat);
    sawAny = true;
    if (!common) allCommon = false;
  };
  const sharedScan = (copy) => {
    const r = scanText(copy);
    for (const term of r.matchedTerms) hit(null, T.SHARED_COMMON_TERMS.has(term.trim()));
    for (const cat of r.categories) cats.add(cat);
  };

  // Every rule that looks for a word or a phrase, on one folded copy of the text.
  // Returns the words (tokens) of that copy.
  const phraseScans = (shared) => {
    const local = foldLocal(shared);
    const tokens = local.match(WORD_TOKEN) || [];
    if (overBudget(started)) throw new Error('screen_over_budget');

    const words = tokens.join(' ');
    sharedScan(shared);
    if (words !== shared) sharedScan(words);
    if (overBudget(started)) throw new Error('screen_over_budget');

    scanTerms(tokens, hit);
    if (overBudget(started)) throw new Error('screen_over_budget');
    scanPairs(tokens, hit);
    scanSectionEight(tokens, hit);
    scanSquashed(tokens, hit);
    scanSlurs(local, hit);
    scanNoticePatterns(words, hit);
    scanFinancialPatterns(shared, hit);
    return tokens;
  };

  const readOne = ({ title, description }, full) => {
    const text = `${title} ${description}`;
    const shared = foldShared(text);
    const tokens = phraseScans(shared);
    if (full) {
      scanScripts(shared, hit);
      scanLookalikeLatin(shared, hit);
      scanSymbols(shared, hit);
      // The unfamiliar-language rule on the whole text, on the description alone
      // and on the title alone.
      scanUnrecognisedLanguage(tokens, hit);
      for (const part of [description, title]) {
        if (part) scanUnrecognisedLanguage(foldLocal(foldShared(part)).match(WORD_TOKEN) || [], hit);
      }
    }
    // The typed-symbol reading: the same phrase scans with every symbol that
    // NFKC would turn into letters read as a space (and the section sign as "section").
    const typed = typedWordsText(text);
    if (typed !== text) {
      const sharedTyped = foldShared(typed);
      if (sharedTyped !== shared) phraseScans(sharedTyped);
    }
    if (overBudget(started)) throw new Error('screen_over_budget');
  };

  readOne(reading, true);
  const seen = [reading];
  for (const { reading: other, full } of extras || []) {
    if (seen.some((r) => r.title === other.title && r.description === other.description)) continue;
    seen.push(other);
    readOne(other, full);
  }

  return { categories: cats, common: sawAny && allCommon };
}

// ─── Known-answer self-test, run when the module loads ─────────────────────
const SELF_TEST_MUST_HOLD = [
  'the tenant uses a wheelchair',
  'restraining order against her ex husband',
  'two kids live in the unit',
  'section 8 voucher holder',
  'paint the walls white',
  'black mold under the sink',
  'su hijo esta enfermo',
  'el nino esta en la escuela',
  'tiene diabetes',
  'orden de restriccion',
  'tenant received a 3 day notice',
  'desalojo en proceso',
  'he was arrested last week',
  'the tenant passed away',
  'speaks Spanish only',
  'SSN 123-45-6789',
  'preg\uFE0Fnant tenant',
  'ICE agents came by',
  'section-8 inspection next week',
  'a \u0663 day notice was posted',
  'tenant uses a \u267F ramp',
  'pr\u025Bgnant tenant',
  'she has a DVRO on file',
];

const SELF_TEST_MUST_PASS = [
  'replace the kitchen faucet',
  'dead bolt sticks',
  'minor leak under the sink',
  'fuga menor en el bano',
  'window blinds are broken',
  'the outlet is dead',
  'pump died again',
  'ice maker not working',
  'caulk gun needed for the tub',
  'Spanish tile roof has a cracked tile',
  'violet paint on the trim',
  'armario de la cocina roto',
  'corte de agua en el edificio',
  'sin embargo el techo gotea',
  'gate code 2040',
  'call John at john@example.com',
  'call 555-123-4567 to schedule',
  'unit 5B garbage disposal jammed',
  'male adapter on the hose bib',
  'half inch 1/2 fitting under the sink-side cabinet',
  'replace the drain pipe \u2705 done',
];

function runSelfTest() {
  let wrong = 0;
  if (compileProblem) return { ok: false, wrong: -1 };
  try {
    for (const s of SELF_TEST_MUST_HOLD) if (analyze({ title: '', description: s }).categories.size === 0) wrong++;
    for (const s of SELF_TEST_MUST_PASS) if (analyze({ title: '', description: s }).categories.size !== 0) wrong++;
  } catch (_err) {
    return { ok: false, wrong: -1 };
  }
  return { ok: wrong === 0, wrong };
}

let selfTest = runSelfTest();
if (!selfTest.ok) {
  // One constant line, once. Every call below now answers held / check_error.
  console.error('[work-order-text-screen] Start-up self-test FAILED: every work order text will be held until this is fixed.');
}

// ─── Public function ────────────────────────────────────────────────────────
function errorResult() {
  return { status: 'held', cause: 'check_error', categories: [], common_word_only: false, screen_version: SCREEN_VERSION };
}

/**
 * @param {{title: string, description: string, spaced?: object, symbols?: object, both?: object}} input
 *   cleaned strings; `spaced`, `symbols` and `both` are the optional other readings from the cleaner,
 *   each { title: string, description: string }
 * @returns {{status: 'cleared'|'held', cause: null|'local_screen'|'check_error',
 *            categories: string[], common_word_only: boolean, screen_version: string}}
 */
function screenWorkOrderText(input) {
  try {
    if (!selfTest.ok) return errorResult();
    if (!input || typeof input !== 'object') return errorResult();
    const { title, description } = input;
    if (typeof title !== 'string' || typeof description !== 'string') return errorResult();
    const extras = [];
    for (const [key, full] of [['spaced', true], ['symbols', false], ['both', false]]) {
      const other = input[key];
      if (other === undefined || other === null) continue;
      // A malformed extra reading is a scanner error (fail closed), never ignored.
      if (typeof other !== 'object' || typeof other.title !== 'string' || typeof other.description !== 'string') return errorResult();
      extras.push({ reading: { title: other.title, description: other.description }, full });
    }
    const { categories, common } = analyze({ title, description }, extras);
    if (categories.size === 0) {
      return { status: 'cleared', cause: null, categories: [], common_word_only: false, screen_version: SCREEN_VERSION };
    }
    const ordered = VOCABULARY.filter((c) => categories.has(c));
    if (ordered.length !== categories.size) return errorResult(); // a name outside the vocabulary: never record it
    return { status: 'held', cause: 'local_screen', categories: ordered, common_word_only: common, screen_version: SCREEN_VERSION };
  } catch (_err) {
    return errorResult();
  }
}

module.exports = {
  screenWorkOrderText,
  SCREEN_VERSION,
  CATEGORY_VOCABULARY: VOCABULARY,
  // exported for tests only
  _internals: {
    foldShared, foldLocal, analyze, runSelfTest, luhnOk,
    termCount: () => termCount,
    selfTestStatus: () => ({ ...selfTest }),
    compileProblem: () => compileProblem,
    SELF_TEST_MUST_HOLD, SELF_TEST_MUST_PASS,
  },
  _setBudgetMsForTesting(ms) { BUDGET_MS = ms === undefined ? 1500 : ms; },
  _forceSelfTestForTesting(ok) { selfTest = ok === undefined ? runSelfTest() : { ok: !!ok, wrong: ok ? 0 : -1 }; },
};
