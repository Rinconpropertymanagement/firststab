/**
 * lib/work-order-notes-content-check.js
 *
 * CURRENTLY UNUSED — nothing in this codebase calls this file. Peter
 * explicitly instructed the content check be removed from the Work Order
 * Notes Alert send path entirely (verbatim notes, no scanning, no AI
 * involvement); see work-order-notes-alert.js's own header and
 * compliance/work-order-note-alerts-content-check-removal-decision-resolution.md
 * for the full, documented record. Left in the repo rather than deleted
 * — cheap to keep, cheap to re-wire if this is ever revisited — but it is
 * dormant. Do not assume this runs just because it exists.
 *
 * The two-layer content check for properties.maintenance_notes, as
 * originally designed to run unconditionally every time a Work Order
 * Notes Alert was about to be sent (work-order-notes-alert-SPEC.md
 * Section 7; hard requirement in
 * compliance/work-order-note-alerts-governance-review.md, conditions 1
 * and 4 — both layers, every attempt including retries, against the
 * CURRENT note value; Layer 2 fails safe on its own error).
 *
 * Sibling implementation to owner-tenant-notes/lib/note-content-check.js's
 * checkManualNoteContent — same combination logic (a hit on EITHER layer
 * flags it; category set is the union of both layers'), same fail-safe
 * try/catch around the Layer 2 call. Copied deliberately rather than
 * imported: that module's Layer 2 classifies a different table's text
 * with a different prompt/context (see work-order-notes-classifier.js),
 * and this field has no `note_text` column of its own to key off of.
 */

const { scanText, TERMS_VERSION } = require('../../maintenance-history/lib/protected-class-terms');
const { classifyWorkOrderNote } = require('./work-order-notes-classifier');

/**
 * @param {string} noteText - properties.maintenance_notes' current value.
 * @returns {Promise<{
 *   flagged_protected_class: boolean,
 *   flagged_category: string|null,
 *   matched_layer: 'keyword'|'model'|'keyword+model'|null,
 *   terms_version: string,
 *   layer2: object|null, // classifyWorkOrderNote's raw result, for latency/cost visibility only — never persisted
 * }>}
 */
async function checkWorkOrderNoteContent(noteText) {
  const layer1 = scanText(noteText);

  let layer2 = null;
  try {
    layer2 = await classifyWorkOrderNote(noteText);
  } catch (err) {
    // Fail SAFE, not fail silent-and-unflagged (governance condition 4):
    // if the classification call itself errors (network, rate limit, bad
    // key), Layer 1's keyword scan is still a real, independent signal
    // that already ran — this instance is never sent with NO content
    // check at all, only without Layer 2's additional judgment for this
    // one attempt. Logged loudly so a repeated failure is visible, same
    // discipline as note-content-check.js's own catch.
    console.error('[work-order-notes-content-check] Layer 2 classification call failed — proceeding on Layer 1 only:', err.message);
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

module.exports = { checkWorkOrderNoteContent };
