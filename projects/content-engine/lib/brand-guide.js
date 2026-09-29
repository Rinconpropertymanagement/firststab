/**
 * lib/brand-guide.js
 * Fetches Rincon's active brand voice guide (the most recent brand_guides
 * row that actually has content) so draft.js and revise.js can apply
 * consistent, PERSISTENT voice/style guidance to every generation.
 *
 * This is deliberately separate from the one-off "inspiration piece"
 * feature in draft.js: an inspiration piece is pasted in by the editor for
 * a single draft and never saved anywhere; the brand guide lives in the
 * database and applies to every draft and revision going forward until a
 * newer version is saved.
 *
 * brand_guides keeps history as new rows (see the migration comment: "a new
 * version is a new row; the most recent row is the active guide"). The seed
 * row has content=NULL (nothing uploaded yet), so this filters to rows with
 * non-null content rather than just taking row #1 — that keeps this correct
 * both before Peter's first upload and after, with no special-casing needed
 * elsewhere.
 */

const { select } = require('./supabase');

/**
 * @returns {Promise<{id: string, content: string, updated_at: string}|null>}
 *   The most recent brand_guides row with content, or null if none exists
 *   yet (e.g. only the empty seed row is present). Callers should treat
 *   null exactly like "no brand guide" — skip that part of the prompt, no
 *   error, no placeholder text.
 */
async function getActiveBrandGuide() {
  const rows = await select(
    'brand_guides',
    'select=id,content,updated_at&content=not.is.null&order=created_at.desc&limit=1'
  );
  const row = rows[0];
  if (!row || !row.content || !row.content.trim()) return null;
  return row;
}

/**
 * Build the persistent "brand voice guide" block injected into a prompt
 * whenever a brand_guides row with content exists. Shared verbatim by
 * draft.js and revise.js so this safety-critical wording never drifts
 * between the two prompts.
 *
 * Unlike an inspiration piece (one-off, a single draft only), this reflects
 * saved guidance that applies to every generation going forward — but it
 * gets the exact same "style only, never facts" treatment for the exact
 * same reason: it's ungrounded outside text being handed to the model, and
 * it must never be mistaken for a second source of facts alongside the
 * grounding claims.
 */
function formatBrandGuideForPrompt(brandGuideContent) {
  return `BRAND VOICE GUIDE (STYLE REFERENCE ONLY — READ THIS CAREFULLY):
This is Rincon Management's standing brand voice and content strategy guide,
saved by the editor and applying to every piece of content, not just this
one. Study its guidance on tone, vocabulary, sentence style, structure, and
any other voice preferences it describes, and write consistent with it.

Do NOT do any of the following with this brand voice guide:
- Do not treat anything it says as a fact, statistic, rule, deadline, dollar
  amount, or legal claim you can use in the draft.
- Do not copy or paraphrase specific claims, numbers, examples, or case
  details from it as if they were verified information.
- Do not treat it as a second source of grounding alongside the GROUNDING
  CLAIMS section. The grounding claims section (if present above) remains the
  ONLY source of legal facts here — that rule is unchanged by this brand
  voice guide being here.

If the brand voice guide happens to state something that reads like a legal
fact, ignore that as a fact entirely — only mimic the writing style, never
the content.

--- START BRAND VOICE GUIDE (style reference only, not a factual source) ---
${brandGuideContent}
--- END BRAND VOICE GUIDE ---

`;
}

/**
 * The "ADDITIONAL HARD RULE" system-prompt bullet for the brand voice guide,
 * shared by draft.js and revise.js. `inspirationNote` lets draft.js append
 * its extra tie-breaker sentence for when an inspiration piece is also
 * present; revise.js (which has no inspiration-piece concept) omits it.
 */
function brandGuideSystemRule({ inspirationNote = '' } = {}) {
  return `

ADDITIONAL HARD RULE — BRAND VOICE GUIDE:
The prompt below includes a BRAND VOICE GUIDE — Rincon's standing voice and
content-strategy reference. This is not specific to this one piece; it's
saved guidance that applies to everything Rincon publishes. It is a STYLE
REFERENCE ONLY. Mimic its voice, tone, and structure preferences — never
treat anything stated in it as a fact, statistic, rule, deadline, dollar
amount, or legal claim you can use. Every legal fact must still come only
from the GROUNDING CLAIMS section (or, if there are no grounding claims, no
specific legal facts should be stated at all, per the rules above).${inspirationNote}`;
}

module.exports = { getActiveBrandGuide, formatBrandGuideForPrompt, brandGuideSystemRule };
