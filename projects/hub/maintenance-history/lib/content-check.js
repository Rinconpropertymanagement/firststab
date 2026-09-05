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
 * Tier A / Tier B (content-screening-tier-redesign-SPEC.md) — six of Layer
 * 1's keyword-matched terms (TIER_B_TERMS below) were responsible for
 * ~91% of this tool's real false-positive volume (build-memo.js Section
 * 1.2): ordinary words ("white," "black," "blind," "diagnosis,"
 * "diagnosed," "too old," "too young for") that usually describe a paint
 * color, window blinds, a mechanic's fault diagnosis, or a worn-out
 * appliance — not a protected characteristic. Every OTHER term
 * protected-class-terms.js knows about stays Tier A: an immediate flag,
 * exactly as before this redesign, no AI call — protected-class-terms.js
 * itself gets zero changes (see that redesign spec's Section 3.1: it is
 * frozen in full; this file and lib/tier-b-classifier.js hold all the new
 * logic). A Tier B term instead gets one short, narrow, per-instance
 * contextual check (lib/tier-b-classifier.js) before deciding whether it
 * actually describes the protected thing or the ordinary thing — see that
 * file's own comment for the prompt and its fail-closed behavior. Layer 2
 * is unaffected by any of this — it still runs and still only ever ADDS a
 * flag, never vetoes one, same as before this redesign.
 *
 * A hit on Tier A, a confirmed-or-ambiguous Tier B check, OR Layer 2 sets
 * flagged_protected_class = TRUE and records a flagged_category. This
 * module never returns the matched text itself in a form meant for
 * logging — callers (router.js) must only write category/matched_layer,
 * and (for Tier B specifically, per content-screening-tier-redesign-
 * SPEC.md Section 5's narrow, named exception) the Tier B triggering term,
 * to audit_log — never claim content, and never any Tier A term.
 */

const { scanText, TERMS_VERSION, CATEGORIES } = require('./protected-class-terms'); // UNCHANGED import, UNCHANGED call
const { classifyTierBTerm, TIER_B_CLASSIFIER_VERSION } = require('./tier-b-classifier'); // NEW file, redesign spec Section 4

// The six terms responsible for ~91% of the 340-record false-positive
// volume (build-memo.js Section 1.2). Defined HERE, not in protected-
// class-terms.js — that file is frozen in full by this redesign (Section
// 3.1). Must exactly match the lowercase strings scanText() returns in
// matchedTerms — confirmed against protected-class-terms.js's CATEGORIES
// (race_color: 'white'/'black'; disability_health: 'blind'/'diagnosis'/
// 'diagnosed'; age: 'too old'/'too young for').
const TIER_B_TERMS = new Set(['white', 'black', 'blind', 'diagnosis', 'diagnosed', 'too old', 'too young for']);

// Kill switch (content-screening-tier-redesign-SPEC.md Section 8) — set
// the env var to the literal string 'false' to make every Tier B term
// behave exactly like Tier A (immediate flag, no AI call): an instant,
// code-free rollback lever if the classifier misbehaves in production.
// Defaults to enabled — any value other than the literal string 'false'
// (including unset) runs the real Tier B check.
const TIER_B_ENABLED = () => process.env.TIER_B_CONTEXTUAL_CHECK_ENABLED !== 'false';

// categoryOf(term) — a load-once lookup built directly from protected-
// class-terms.js's already-exported CATEGORIES data, the same pattern
// router.js's own TERM_TO_CATEGORY already uses for the grouped-review
// feature (redesign spec Open Item #5), rather than a hand-duplicated
// second copy of the term/category mapping. Covers every term protected-
// class-terms.js knows about, not just the six Tier B terms — tierATerms
// below can be any term from that file's full list.
const TERM_TO_CATEGORY = {};
for (const [category, terms] of Object.entries(CATEGORIES)) {
  for (const term of terms) {
    if (!(term in TERM_TO_CATEGORY)) TERM_TO_CATEGORY[term] = category;
  }
}
function categoryOf(term) {
  return TERM_TO_CATEGORY[term] || 'unspecified';
}

/**
 * @param {object} claim
 * @param {string} claim.claim_text
 * @param {boolean} [claim.modelFlag] - Layer 2: did the extraction model
 *   itself flag this claim as protected-class-adjacent?
 * @param {string}  [claim.modelCategory] - Layer 2's stated category, free text.
 * @returns {Promise<{
 *   flagged_protected_class: boolean,
 *   flagged_category: string|null,
 *   matched_layer: 'keyword_tier_a'|'keyword_tier_a+model'|'keyword_tier_b_confirmed'|'keyword_tier_b_confirmed+model'|'model'|null,
 *   terms_version: string,
 *   tier_b_results: Array<{term: string, category: string, classification: string, disposition: string, model_version: string|null}>,
 * }>}
 */
async function checkClaim(claim) {
  const layer1 = scanText(claim.claim_text); // UNCHANGED — scanText() itself never modified
  const layer2Hit = !!claim.modelFlag;

  const tierATerms = layer1.matchedTerms.filter(t => !TIER_B_TERMS.has(t));
  const tierBTerms = layer1.matchedTerms.filter(t => TIER_B_TERMS.has(t));

  let tierBResults = []; // returned so the caller can write one audit_log
                          // entry per Tier B term checked — Section 5
  let tierBFlagged = false;

  if (tierBTerms.length > 0) {
    if (!TIER_B_ENABLED()) {
      // Kill switch engaged: Tier B behaves exactly like Tier A did before
      // this change (immediate flag), and no AI call is made.
      tierBFlagged = true;
      tierBResults = tierBTerms.map(term => ({
        term, category: categoryOf(term), classification: 'kill_switch_engaged',
        disposition: 'flagged', model_version: null,
      }));
    } else {
      tierBResults = await Promise.all(tierBTerms.map(term =>
        classifyTierBTerm({ term, category: categoryOf(term), claimText: claim.claim_text })
        // classifyTierBTerm() itself fails closed: any error, timeout, or
        // unparseable response resolves to { classification: 'ambiguous' }
        // rather than throwing — see lib/tier-b-classifier.js.
      ));
      tierBFlagged = tierBResults.some(r => r.classification !== 'ordinary');
      // 'protected' -> flagged. 'ambiguous' -> flagged (counsel: "identify
      // it for human judgment rather than assuming discrimination" — the
      // review queue IS that human-judgment routing mechanism).
    }
  }

  const layer1Flagged = tierATerms.length > 0 || tierBFlagged;
  const flagged = layer1Flagged || layer2Hit; // OR with Layer 2 UNCHANGED —
                                                // Layer 2 still only adds, never vetoes

  if (!flagged) {
    return { flagged_protected_class: false, flagged_category: null, matched_layer: null, terms_version: TERMS_VERSION, tier_b_results: tierBResults };
  }

  const categories = new Set([...tierATerms.map(categoryOf), ...(tierBFlagged ? tierBTerms.map(categoryOf) : [])]);
  if (layer2Hit && claim.modelCategory) categories.add(String(claim.modelCategory).trim());
  else if (layer2Hit) categories.add('model_judgment_unspecified');

  // matched_layer gains tier granularity (a JS string, not a DB column —
  // no migration involved). Existing values 'keyword'/'model'/
  // 'keyword+model' become tier-specific; any code or dashboard reading
  // these strings needed updating alongside this change.
  let matched_layer;
  if (tierATerms.length > 0)      matched_layer = layer2Hit ? 'keyword_tier_a+model'          : 'keyword_tier_a';
  else if (tierBFlagged)          matched_layer = layer2Hit ? 'keyword_tier_b_confirmed+model' : 'keyword_tier_b_confirmed';
  else                             matched_layer = 'model';

  return {
    flagged_protected_class: true,
    flagged_category: Array.from(categories).join(', '),
    matched_layer,
    terms_version: TERMS_VERSION,
    tier_b_results: tierBResults, // [] if no Tier B term matched
  };
}

module.exports = { checkClaim, TIER_B_CLASSIFIER_VERSION };
