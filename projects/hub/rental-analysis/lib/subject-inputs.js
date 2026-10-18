/**
 * lib/subject-inputs.js
 * Plain checks on what a person types into the "run analysis" form, so a silly
 * value (a 5-million square foot house, a zero byte hidden in the address, the
 * text "false" in the Furnished box) is refused with a short, clear message
 * BEFORE anything is looked up or saved. Without these checks the database
 * refuses the value later and the screen shows raw database wording.
 *
 * Both entry points (server.js and the Hub's router.js) use these same
 * functions, so they refuse the same things.
 */

// The most any of these may be. Real homes are far below every one of them; the
// point is only to stop absurd values from ever reaching the database.
const MAX_SQFT = 20000;
const MAX_BEDROOMS = 20;
const MAX_BATHROOMS = 20;
const MAX_LEASE_TERM_MONTHS = 120;

/**
 * Removes control characters (a zero byte, tabs, line breaks, escape codes and
 * the like) from typed text. A tab or line break becomes a space so two words do
 * not run together; every other control character is simply dropped; runs of
 * spaces left behind become one space.
 */
function stripControlChars(text) {
  return String(text)
    .replace(/[\t\n\r\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/ {2,}/g, ' ');
}

/**
 * @returns {string|null} a plain message, or null when every value is within the limits
 */
function checkSubjectLimits({ bedrooms, bathrooms, sqft, leaseTermMonths }) {
  if (sqft > MAX_SQFT) return `subject_sqft must be ${MAX_SQFT.toLocaleString('en-US')} or less.`;
  if (bedrooms > MAX_BEDROOMS) return `subject_bedrooms must be ${MAX_BEDROOMS} or less.`;
  if (bathrooms > MAX_BATHROOMS) return `subject_bathrooms must be ${MAX_BATHROOMS} or less.`;
  if (leaseTermMonths > MAX_LEASE_TERM_MONTHS) return `lease_term_months must be ${MAX_LEASE_TERM_MONTHS} or less.`;
  return null;
}

/**
 * "Furnished" box. Left out means no. Otherwise it must be exactly true or false
 * (a JSON boolean): the text "false" is NOT quietly treated as yes.
 * @returns {{value: boolean}|{error: string}}
 */
function parseFurnishedInput(raw) {
  if (raw === undefined || raw === null) return { value: false };
  if (typeof raw === 'boolean') return { value: raw };
  return { error: 'furnished must be true or false, or omitted.' };
}

// The typed address is read by many pattern matches and goes into the writer's prompt, so an address of thousands of
// characters is refused with a plain message (real addresses are far shorter).
const MAX_ADDRESS_LENGTH = 300;

module.exports = { MAX_ADDRESS_LENGTH, MAX_SQFT, MAX_BEDROOMS, MAX_BATHROOMS, MAX_LEASE_TERM_MONTHS, stripControlChars, checkSubjectLimits, parseFurnishedInput };
