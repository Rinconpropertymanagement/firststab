/**
 * lib/condition-display.js
 * The wording for the two "condition" facts the staff report SHOWS (CMA-QUALITY-SPEC.md
 * Item 3, Phase E). Both are display only. Neither one is ever used to work out a rent,
 * a range, a price, the confidence label, which homes count, or what the written
 * explanation says. No file that does those things may read anything from here (a test
 * checks that).
 *
 *   1. The condition a staff member typed in for THE HOME BEING PRICED, when someone
 *      has actually seen it: "Condition (entered by staff): B, some nice finishes but
 *      some dated fixtures". Nothing is shown when it was not entered.
 *   2. The words the MLS itself lists for a comparable home, copied as the MLS spells
 *      them: "MLS lists: Turnkey, Updated/Remodeled". They are never turned into an
 *      A-to-F grade, never summarised, and never compared with the home being priced.
 *
 * Neither fact goes on the owner page. A condition read from listing text is NOT built:
 * testing showed it did not improve accuracy and over-rated homes.
 *
 * Both entry points reach this through lib/outcome.js, so a report that has just been run
 * and a saved report that is reopened show exactly the same words.
 */

const { CONDITION_RATINGS } = require('./constants');

// ─── The home being priced (typed in by staff) ───────────────────────────────

// The six grades, with the one-line plain meaning staff see beside each (the form shows the
// same words; a test checks the two stay identical). The grade list itself is
// CONDITION_RATINGS in lib/constants.js, the exact list the database accepts.
const SUBJECT_CONDITION_DESCRIPTIONS = Object.freeze({
  'A+': 'completely remodeled with the best upgrades',
  'A': 'very nice finishes',
  'B': 'some nice finishes but some dated fixtures',
  'C': 'completely dated',
  'D': 'run down',
  'F': 'trashed',
});

const SUBJECT_CONDITION_PREFIX = 'Condition (entered by staff): ';

/**
 * What the answer carries for the home's condition, or null when none was entered.
 * Only one of the six grades, spelled exactly, counts; anything else is treated as
 * "not entered" (the request check refuses a bad value before it is ever saved, so
 * this only guards a damaged saved row).
 * @param {*} grade - the saved subject_condition
 * @returns {{grade: string, description: string, line: string}|null}
 */
function subjectConditionForAnswer(grade) {
  if (typeof grade !== 'string' || !CONDITION_RATINGS.includes(grade)) return null;
  const description = SUBJECT_CONDITION_DESCRIPTIONS[grade];
  return { grade, description, line: `${SUBJECT_CONDITION_PREFIX}${grade}, ${description}` };
}

// ─── The MLS's own words for a comparable home ───────────────────────────────

// The condition words the MLS (CRMLS, through Recore) uses in its PropertyCondition list,
// spelled as the MLS spells them. Found by reading real lease and sale records in October
// 2026 (about 2,800 records, 400 of them with a value). The MLS also puts two paperwork
// notes in that list, "Building Permit" and "Termite Clearance": they say nothing about the
// state of the home, so they are left off this list. They stay saved with the comp but are
// treated like any other unknown word and are NOT shown. To show a new word, add it here;
// nothing else needs to change.
const MLS_CONDITION_WORDS = Object.freeze([
  'Turnkey',
  'Updated/Remodeled',
  'Additions/Alterations',
  'Repairs Cosmetic',
  'Repairs Major',
  'Fixer',
  'Under Construction',
]);

const MLS_CONDITION_PREFIX = 'MLS lists: ';

// capital letters and spacing do not matter when matching; the MLS spelling above is what is shown
const KNOWN_MLS_WORDS = new Map(MLS_CONDITION_WORDS.map(word => [word.toLowerCase(), word]));

// A real record has two or three words at most. Reading no more than this many pieces means an
// absurdly long saved value can never make this slow.
const MAX_PIECES_READ = 50;

/**
 * The known MLS condition words in a value, each once, in the order given.
 * Accepts what the MLS sends (a list such as ["Turnkey","Updated/Remodeled"], or an empty list)
 * and what is saved in rental_comps.mls_condition (those words joined with ", ").
 * Words that are not on the known list, empty pieces and anything that is not text are dropped.
 * @param {*} value
 * @returns {string[]}
 */
function mlsConditionWords(value) {
  let pieces = [];
  if (Array.isArray(value)) pieces = value.slice(0, MAX_PIECES_READ);
  else if (typeof value === 'string') pieces = value.split(',', MAX_PIECES_READ);
  const found = [];
  for (const piece of pieces) {
    if (typeof piece !== 'string') continue;
    const word = KNOWN_MLS_WORDS.get(piece.replace(/\s+/g, ' ').trim().toLowerCase());
    if (word && !found.includes(word)) found.push(word);
  }
  return found;
}

/**
 * The line shown on a comparable home's card, or null when the MLS gave no known word.
 * @param {*} value - the saved mls_condition (or the MLS's own list)
 * @returns {string|null}
 */
function mlsConditionLine(value) {
  const words = mlsConditionWords(value);
  return words.length ? `${MLS_CONDITION_PREFIX}${words.join(', ')}` : null;
}

module.exports = {
  SUBJECT_CONDITION_DESCRIPTIONS,
  SUBJECT_CONDITION_PREFIX,
  MLS_CONDITION_WORDS,
  MLS_CONDITION_PREFIX,
  subjectConditionForAnswer,
  mlsConditionWords,
  mlsConditionLine,
};
