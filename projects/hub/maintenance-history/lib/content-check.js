/**
 * lib/content-check.js
 * The two-layer content check (SPEC.md "The Content Check", GOVERNANCE.md
 * Rule 9) — run on every candidate claim before insert, no exceptions.
 *
 * Layer 1 — keyword/phrase scan (protected-class-terms.js). Deterministic,
 * fast, auditable.
 * Layer 2 — the extraction model's own judgment. Since Claude already reads
 * the source text to produce the claim, extract-claims.js's prompt asks it
 * to self-report anything protected-class-adjacent it notices even when no
 * listed keyword matches (catches subtler phrasing Layer 1 would miss).
 * That self-report arrives as `modelFlag`/`modelCategory` on the candidate
 * claim and is combined here.
 *
 * A hit on EITHER layer sets flagged_protected_class = TRUE and records a
 * flagged_category. This module never returns the matched text itself in a
 * form meant for logging — callers (router.js) must only write category/
 * matched_layer to audit_log, never claim content, per SPEC.md.
 */

const { scanText, TERMS_VERSION } = require('./protected-class-terms');

/**
 * @param {object} claim
 * @param {string} claim.claim_text
 * @param {boolean} [claim.modelFlag] - Layer 2: did the extraction model
 *   itself flag this claim as protected-class-adjacent?
 * @param {string}  [claim.modelCategory] - Layer 2's stated category, free text.
 * @returns {{
 *   flagged_protected_class: boolean,
 *   flagged_category: string|null,
 *   matched_layer: 'keyword'|'model'|'keyword+model'|null,
 *   terms_version: string,
 * }}
 */
function checkClaim(claim) {
  const layer1 = scanText(claim.claim_text);
  const layer2Hit = !!claim.modelFlag;

  const flagged = layer1.flagged || layer2Hit;
  if (!flagged) {
    return { flagged_protected_class: false, flagged_category: null, matched_layer: null, terms_version: TERMS_VERSION };
  }

  const categories = new Set(layer1.categories);
  if (layer2Hit && claim.modelCategory) categories.add(String(claim.modelCategory).trim());
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
  };
}

module.exports = { checkClaim };
