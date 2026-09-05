/**
 * lib/note-content-check.js
 * The two-layer content check for operational_notes (GOVERNANCE.md Rule 9;
 * owner-tenant-operational-notes-SPEC.md Section 5), combined the same
 * shape as maintenance-history/lib/content-check.js's checkClaim() —
 * intentionally NOT imported from that file, since this module's Layer 2
 * calls a different function (classifyManualNote, a fresh classification
 * call — see manual-note-classifier.js's own header for why this can't
 * reuse extract-claims.js's self-report convention) and this table has no
 * `claim_text` field to key off of. A sibling implementation, not a fork:
 * same combination logic (a hit on EITHER layer flags the row; category
 * set is the union of both layers'), same restraint (never returns the
 * note's own text in a form meant for logging).
 */

const { scanText, TERMS_VERSION } = require('../../maintenance-history/lib/protected-class-terms');
const { classifyManualNote } = require('./manual-note-classifier');

/**
 * @param {string} noteText
 * @returns {Promise<{
 *   flagged_protected_class: boolean,
 *   flagged_category: string|null,
 *   matched_layer: 'keyword'|'model'|'keyword+model'|null,
 *   terms_version: string,
 *   layer2: object|null, // classifyManualNote's raw result, for latency/cost reporting only — never persisted
 * }>}
 */
async function checkManualNoteContent(noteText) {
  const layer1 = scanText(noteText);

  let layer2 = null;
  try {
    layer2 = await classifyManualNote(noteText);
  } catch (err) {
    // Fail SAFE, not fail silent-and-unflagged: if the classification call
    // itself errors (network, rate limit, bad key), Layer 1's keyword scan
    // is still a real, independent signal that already ran — this note is
    // never inserted with NO content check at all, only without Layer 2's
    // additional judgment for this one submission. Logged loudly so a
    // repeated failure is visible, same "log and continue, don't take the
    // whole request down" discipline as writeAuditLog elsewhere in this
    // tool.
    console.error('[note-content-check] Layer 2 classification call failed — proceeding on Layer 1 only:', err.message);
  }

  const layer2Hit = !!(layer2 && layer2.modelFlag);
  const flagged = layer1.flagged || layer2Hit;

  if (!flagged) {
    return { flagged_protected_class: false, flagged_category: null, matched_layer: null, terms_version: TERMS_VERSION, layer2 };
  }

  const categories = new Set(layer1.categories);
  if (layer2Hit && layer2.modelCategory) categories.add(String(layer2.modelCategory).trim());
  else if (layer2Hit) categories.add('model_judgment_unspecified');

  let matched_layer;
  if (layer1.flagged && layer2Hit) matched_layer = 'keyword+model';
  else if (layer1.flagged) matched_layer = 'keyword';
  else matched_layer = 'model';

  return {
    flagged_protected_class: true,
    flagged_category: Array.from(categories).join(', '),
    matched_layer,
    terms_version: TERMS_VERSION,
    layer2,
  };
}

module.exports = { checkManualNoteContent };
