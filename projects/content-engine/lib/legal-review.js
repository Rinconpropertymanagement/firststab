/**
 * lib/legal-review.js
 * Status recompute + dedup helpers for legal_claim_reviews (migration
 * supabase/migrations/20260801000000_legal_claim_reviews.sql). Lives in its
 * own small file rather than lib/draft.js or lib/revise.js because both of
 * those AND the future conversational-edit feature need to call
 * recomputeLegalReviewStatus() — same "one shared piece, not duplicated"
 * reasoning as lib/package-draft.js's detectLegalClaims().
 *
 * NEITHER function here writes a legal_claim_reviews row itself — that's
 * lib/draft.js's/lib/revise.js's job, using detectLegalClaims()'s output.
 * This file only ever READS legal_claim_reviews and, in
 * recomputeLegalReviewStatus(), writes the single derived
 * content_items.legal_review_status column.
 *
 * IMPORTANT — matches the migration's own explicit design rule: this file
 * must NEVER be turned into a database trigger. Recomputation only ever
 * happens because application code called recomputeLegalReviewStatus()
 * explicitly, so there's always a plain code path a human can trace ("who
 * called this, and why") rather than a status silently flipping on its own.
 */

const { select, update } = require('./supabase');
const { getClient } = require('./anthropic');
// Reused, not reimplemented — see findMissingLegalClaimBracketFindings()
// below for why the structural backstop needs these two: the SAME
// sentence-chunking detectLegalClaims()'s own Layer 1 uses (so the
// "context" a fallback row shows a reviewer is built the same way an
// ordinary finding's context already is), and the SAME best-effort
// markdown-link source-URL heuristic detectLegalClaims() itself uses.
// package-draft.js has no require on this file, so this is a safe,
// one-directional dependency (no cycle).
const { splitIntoSentenceLikeChunks, extractNearbySourceUrl } = require('./package-draft');

const MASON_MODEL = 'claude-opus-4-8';

// A legal_claim_reviews row is RESOLVED only if Peter has recorded one of
// these three decisions. 'consulting_attorney' and NULL are both still
// UNRESOLVED — this is the migration's own explicit rule (see its header
// comment): 'consulting_attorney' is a flag that review is in flight, not a
// verdict, and must never be read as cleared-to-publish.
const RESOLVED_PETER_DECISIONS = ['approved_as_is', 'approved_with_edit', 'removed_from_draft'];

/**
 * Recompute and write content_items.legal_review_status from the current
 * legal_claim_reviews rows for one content item:
 *   - 'not_required' — zero rows exist for this item at all
 *   - 'cleared'       — at least one row exists, and every row is resolved
 *   - 'needs_review'  — at least one row is unresolved (peter_decision is
 *                        NULL or 'consulting_attorney')
 *
 * Must be called EXPLICITLY by application code after anything that could
 * change the answer: a new finding gets written (lib/draft.js/lib/revise.js,
 * right after detectLegalClaims()), or Mason/Peter records a decision on an
 * existing row (the separate, later Approve-route gate work). Never a
 * trigger — see this file's own header comment.
 *
 * @param {string} contentItemId
 * @returns {Promise<'not_required'|'needs_review'|'cleared'>} the status just written
 */
async function recomputeLegalReviewStatus(contentItemId) {
  if (!contentItemId) {
    throw new Error('recomputeLegalReviewStatus() requires a contentItemId');
  }

  const rows = await select(
    'legal_claim_reviews',
    `select=id,peter_decision&content_item_id=eq.${contentItemId}`
  );

  let status;
  if (rows.length === 0) {
    status = 'not_required';
  } else {
    const hasUnresolvedRow = rows.some((r) => !RESOLVED_PETER_DECISIONS.includes(r.peter_decision));
    status = hasUnresolvedRow ? 'needs_review' : 'cleared';
  }

  await update('content_items', `id=eq.${contentItemId}`, { legal_review_status: status });
  return status;
}

// ============================================================
// Near-duplicate claim-text comparison — same underlying problem, same
// solution shape as lib/chat.js's extractNewNeedsHumanReviewFlags()
// (word-overlap similarity + a numeric-token exact-match guard), adapted
// here for comparing full claim_text sentences instead of short
// "[NEEDS HUMAN REVIEW: ...]" flag descriptions.
//
// BUG FIX (TARS, 2026-08-08): filterNewLegalClaimFindings() below used to
// dedupe on EXACT claim_text match only. The same underlying legal fact,
// restated with a trailing-period difference or a slightly different
// sentence boundary across revision rounds (e.g. detectLegalClaims()'s own
// chunking/Layer 2 wording drifting slightly round to round), compared as
// two DIFFERENT strings and created a second review-queue row for the same
// claim instead of being recognized as a restatement. Not a safety hole —
// it errs toward MORE flagging, not less — but it clutters Mason's/Peter's
// review queue. Reusing the same Jaccard-similarity approach already proven
// for lib/chat.js's identical near-duplicate problem, rather than inventing
// a new comparison from scratch.
//
// Duplicated here rather than imported from lib/chat.js: lib/chat.js itself
// requires lib/revise.js, which requires THIS file (legal-review.js) for
// recomputeLegalReviewStatus()/filterNewLegalClaimFindings() — importing
// lib/chat.js from here would create a require cycle
// (legal-review -> chat -> revise -> legal-review). Same "kept as its own
// copy for require-cycle reasons" pattern this codebase already uses
// elsewhere (see lib/package-draft.js's getLinkedClaimsForMason()).
// ============================================================

const CLAIM_COMPARISON_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'to', 'of', 'on', 'in', 'for', 'that', 'this',
  'is', 'are', 'was', 'were', 'it', 'its', 'as', 'by', 'with', 'or', 'be',
  'not', 'no', 'any', 'these', 'those', 'has', 'have', 'had', 'so', 'but',
  'yet', 'if', 'than', 'then', 'there', 'here', 'from', 'about',
]);

/**
 * Reduce a claim_text string to the set of words that actually carry its
 * substance — lowercased, punctuation stripped (except interior '.' so a
 * statute number like "1950.5" survives as one token), filler words
 * removed. Two claims about the SAME underlying fact end up with (nearly)
 * the same word set even after a trailing-period or minor sentence-boundary
 * difference; two claims about genuinely DIFFERENT facts don't.
 *
 * BUG FIX (found while writing this fix's own test): a trailing sentence-
 * ending period is stripped BEFORE tokenizing, not left in place. Without
 * this, "...to $5,000" (no trailing period — a claim_text captured mid-
 * sentence) and "...to $5,000." (trailing period — the same claim restated
 * as a full sentence) produce DIFFERENT number tokens ("000" vs "000.",
 * since the period has nothing but a digit before it and sticks to that
 * token) — exactly defeating numericTokens()'s exact-match guard on the
 * single most common real-world shape of "the same claim, trailing-period
 * difference" this fix exists to catch. Only ONE trailing period is
 * stripped (not every period), so an interior decimal point in a number
 * that happens to end the sentence (e.g. "...Civil Code § 1950.5.") is
 * preserved as "1950.5", not truncated to "1950".
 */
function claimSignificantWords(claimText) {
  const withoutTrailingPeriod = (claimText || '').trim().replace(/\.$/, '');
  return new Set(
    withoutTrailingPeriod
      .toLowerCase()
      .replace(/[^a-z0-9.\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word && !CLAIM_COMPARISON_STOPWORDS.has(word))
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  let shared = 0;
  for (const word of setA) {
    if (setB.has(word)) shared++;
  }
  const unionSize = setA.size + setB.size - shared;
  return unionSize === 0 ? 1 : shared / unionSize;
}

/**
 * The number-bearing tokens in a word set (anything containing a digit —
 * "30", "1950.5", "5000"). Pulled out and compared separately from overall
 * word-overlap: two claims that are otherwise phrased almost identically
 * ("a 30-day notice period" vs. "a 60-day notice period") share nearly
 * every word EXCEPT the one number that actually makes them two different
 * facts. Overall Jaccard similarity alone would score that pair as highly
 * similar and wrongly swallow the second, genuinely new claim as "just a
 * reword" of the first — a numeric mismatch always overrides an otherwise-
 * high word-overlap score. Same guard as lib/chat.js's identical helper.
 */
function numericTokens(wordSet) {
  const nums = new Set();
  for (const word of wordSet) {
    if (/\d/.test(word)) nums.add(word);
  }
  return nums;
}

function sameTokenSet(setA, setB) {
  if (setA.size !== setB.size) return false;
  for (const token of setA) {
    if (!setB.has(token)) return false;
  }
  return true;
}

// How much word-overlap counts as "this is the same claim, just reworded"
// rather than "this is a genuinely different, new claim." Same bar as
// lib/chat.js's identical SAME_FLAG_SIMILARITY_THRESHOLD.
const SAME_CLAIM_SIMILARITY_THRESHOLD = 0.6;

/**
 * True if `claimText` is a near-duplicate (same substance, possibly
 * reworded/re-punctuated) of `existingClaimText` — used by
 * filterNewLegalClaimFindings() below in place of exact string equality.
 */
function isNearDuplicateClaimText(claimText, existingClaimText) {
  if (claimText === existingClaimText) return true; // fast path, also handles both empty
  const candidateWords = claimSignificantWords(claimText);
  const existingWords = claimSignificantWords(existingClaimText);
  return (
    sameTokenSet(numericTokens(candidateWords), numericTokens(existingWords)) &&
    jaccardSimilarity(candidateWords, existingWords) >= SAME_CLAIM_SIMILARITY_THRESHOLD
  );
}

/**
 * Given fresh candidates from lib/package-draft.js's detectLegalClaims(),
 * drop anything that already has a legal_claim_reviews row for this content
 * item that's a NEAR-DUPLICATE (see isNearDuplicateClaimText() above — was
 * exact-string-only until the near-duplicate bug fix described above) — so
 * re-running detectLegalClaims() on every revision round doesn't spam a
 * duplicate row for a sentence that hasn't substantively changed since the
 * last round.
 *
 * The build spec's literal filter condition is narrower — only drop a
 * candidate whose exact wording already has a RESOLVED row. This function
 * drops on ANY existing row for that wording EXCEPT a 'removed_from_draft'
 * one (see the REFINEMENT note below) — an UNRESOLVED existing row
 * (peter_decision NULL or 'consulting_attorney') for essentially the same
 * sentence means it's already sitting in Mason's/Peter's queue, so
 * inserting a second, near-identical pending row would just be duplicate
 * noise, not a new finding; likewise 'approved_as_is'/'approved_with_edit'
 * rows are a settled, still-correct decision that shouldn't be re-litigated
 * just because the same wording showed up again. If a reviewer later wants
 * "one row per (claim_text, round)" instead, that's a different, larger
 * design — flagged in this build's report rather than silently decided
 * here.
 *
 * REFINEMENT (TARS, 2026-08-02): 'removed_from_draft' rows are deliberately
 * EXCLUDED from the dedup set, unlike every other peter_decision value.
 * Peter explicitly rejecting a claim is a decision that THIS specific
 * wording should NOT be published — if that same claim reappears in a
 * later revision round (e.g. the model re-adds it, or a subsequent edit
 * reintroduces it), deduping against the old rejected row would silently
 * swallow it: no new row gets created, legal_review_status can read
 * 'cleared' while the article actually contains a previously-rejected,
 * currently-unreviewed legal claim that slipped back in. Excluding
 * 'removed_from_draft' rows here means that claim is always treated
 * as brand-new and gets a fresh row (and a fresh, unresolved
 * legal_review_status) every time it resurfaces, however many times that
 * takes.
 *
 * @param {string} contentItemId
 * @param {{claimText: string}[]} candidates - detectLegalClaims()'s output
 * @returns {Promise<object[]>} the subset of candidates that are genuinely new
 */
async function filterNewLegalClaimFindings(contentItemId, candidates) {
  if (!contentItemId) {
    throw new Error('filterNewLegalClaimFindings() requires a contentItemId');
  }
  if (!candidates || candidates.length === 0) return [];

  const existingRows = await select(
    'legal_claim_reviews',
    `select=claim_text,peter_decision&content_item_id=eq.${contentItemId}`
  );
  const comparableExistingClaims = existingRows
    .filter((r) => r.peter_decision !== 'removed_from_draft')
    .map((r) => r.claim_text);

  return candidates.filter(
    (c) => !comparableExistingClaims.some((existingText) => isNearDuplicateClaimText(c.claimText, existingText))
  );
}

/**
 * ============================================================
 * findMissingLegalClaimBracketFindings() — STRUCTURAL BACKSTOP
 * ============================================================
 * Built (TARS, 2026-08-08) after a real, live-reproduced gap: in a real
 * reviseContent() run, the AI correctly wrote a self-sourced legal fact
 * wrapped in "[LEGAL CLAIM PENDING REVIEW: ...]" (per lib/draft.js's/
 * lib/revise.js's own WEB SEARCH prompt rule) with a real cited source — but
 * detectLegalClaims()'s Layer 2 (the AI-comprehension call) failed to
 * extract it, so ZERO legal_claim_reviews row got created for it. TARS
 * confirmed this is a rare, STOCHASTIC single-pass miss (the same scenario
 * caught correctly 5/5 times on repeat, and 32 targeted attempts to force a
 * reliable repro all failed) — not a bug tied to any particular input shape.
 * The practical effect: a claim can sit fully visible in the published
 * article body, with a real source, and be completely invisible to Mason's
 * review and to content_items.legal_review_status — an article could read
 * 'cleared' while it still contains an unreviewed, self-sourced legal claim.
 *
 * WHY THIS IS A SEPARATE, DETERMINISTIC FUNCTION RATHER THAN "make Layer 2
 * more reliable": this codebase already learned this exact lesson once, on a
 * different bug — the leaked-narration saga (see lib/draft.js's/
 * lib/revise.js's ARTICLE_MARKER comments): three rounds of prompt patching
 * failed to close a stochastic single-pass AI failure, and only a
 * deterministic, plain-code structural check (a hard marker, checked
 * mechanically) actually closed it. Same shape of problem here, same fix:
 * this function makes ZERO Claude API calls and depends on NOTHING about
 * whether Layer 1/2 succeeded — it is a plain regex scan of the article body
 * text plus a plain-code comparison against what's already in the database,
 * so it catches the gap even in the run where the AI-comprehension call
 * happens to fail.
 *
 * WHAT IT DOES: finds every "[LEGAL CLAIM PENDING REVIEW: ...]" bracket
 * instance literally sitting in `body` (the exact same marker text
 * lib/draft.js's/lib/revise.js's own prompts instruct the model to use — see
 * either file's webSearchRuleForLegalTopics), and for each one, checks
 * whether ANY existing legal_claim_reviews row for this content item already
 * corresponds to it — see bracketInstanceIsAlreadyCovered()'s own comment
 * below (now on its second bug-fix round) for exactly how "corresponds to"
 * is decided and why claim_context is deliberately NOT part of that
 * decision. A candidate whose own literal bracket text/description overlaps
 * an existing row's claim_text is treated as already covered; only a
 * bracket with NO such corresponding row at all is reported as missing.
 *
 * PURE READ, same as detectLegalClaims(): makes no database WRITES and no
 * Claude API calls, only a read-only `select`. The caller
 * (lib/draft.js/lib/revise.js) is responsible for actually inserting a
 * fallback row for anything this returns — same "detection is separate from
 * insertion" split this file's own header comment already documents for
 * filterNewLegalClaimFindings() above, and the same reason: draft.js/
 * revise.js are the only places that already know how to build a full
 * legal_claim_reviews insert payload and how to run Mason's review
 * afterward, so there is no reason to duplicate that here.
 *
 * A caller should run this AFTER inserting whatever Layer 1/2 already found
 * this round (so this function's own `select` sees those rows too, and
 * correctly treats them as "already covered" rather than re-flagging them) —
 * see lib/draft.js's/lib/revise.js's own wiring for the exact call order.
 *
 * @param {string} contentItemId
 * @param {string} body - the FINAL, already-cleaned article body about to be
 *   (or just) saved to content_items — i.e. the exact same `body`/
 *   `revisedBody` draft.js/revise.js pass to detectLegalClaims() itself,
 *   BEFORE the mechanical citation/related-reading link-insertion passes run
 *   (same reasoning as detectLegalClaims()'s own call site: a bracket is
 *   plain prose at that point, not yet turned into markdown link syntax).
 * @returns {Promise<{claimText: string, context: string, detectedBy: 'structural_flag_scan', sourceUrl: string|null}[]>}
 */

const LEGAL_CLAIM_BRACKET_REGEX = /\[LEGAL CLAIM PENDING REVIEW:\s*([^\]]*)\]/g;

/**
 * Find every "[LEGAL CLAIM PENDING REVIEW: ...]" bracket instance in `body`,
 * paired with the sentence-like chunk (lib/package-draft.js's
 * splitIntoSentenceLikeChunks()) that contains it — falling back to the bare
 * bracket text itself if, for whatever reason, no chunk is found to contain
 * it (should not normally happen, since every chunk is a verbatim substring
 * of `body` and the bracket is always literally present in `body`).
 */
function findLegalClaimBracketInstances(body) {
  const text = body || '';
  const chunks = splitIntoSentenceLikeChunks(text);
  const instances = [];
  const regex = new RegExp(LEGAL_CLAIM_BRACKET_REGEX.source, LEGAL_CLAIM_BRACKET_REGEX.flags);
  let match;
  while ((match = regex.exec(text))) {
    const fullBracketText = match[0];
    const description = (match[1] || '').trim();
    const containingChunk = chunks.find((c) => c.includes(fullBracketText));
    instances.push({
      fullBracketText,
      description,
      context: containingChunk || fullBracketText,
    });
  }
  return instances;
}

/**
 * True if an existing row already corresponds to one bracket instance.
 *
 * BUG FIX ROUND 1 (Q, confirmed live in that fix's own end-to-end testing,
 * 2026-08-08): the original version of this check compared the bracket's
 * whole sentence-like CONTEXT (the full chunk from
 * splitIntoSentenceLikeChunks() containing the bracket) against an existing
 * row's claim_text via bidirectional substring containment. That is too
 * permissive whenever the model writes a long, comma/em-dash-joined
 * run-on "sentence" with NO sentence-ending period inside it — Layer 1's
 * chunker (deliberately simple, see its own comment) never splits that
 * run-on into smaller pieces, so ONE chunk can genuinely contain two (or
 * more) only loosely related facts. Confirmed live: a real reviseContent()
 * run wrote one such run-on sentence containing BOTH a bracketed
 * "three-year retention" claim AND, elsewhere in the SAME chunk, prose that
 * became a totally unrelated ai_comprehension row's claim_text — the old
 * chunk-vs-claim_text containment check treated that unrelated row as
 * "covering" the bracket purely because both happened to sit in the same
 * oversized chunk, and the backstop silently skipped a real gap. Round 1's
 * fix anchored the comparison to the BRACKET ITSELF (its full literal text,
 * and its own inner description) instead of the surrounding chunk — but
 * checked that anchor against BOTH claim_text AND claim_context of each
 * existing row.
 *
 * BUG FIX ROUND 2 / ROUND 4 OF THIS GAP (TARS, 2026-08-08): checking
 * claim_context reopened the EXACT SAME bug class Round 1 had just closed
 * for claim_text, just via the other field. buildLegalClaimsSystemPrompt()
 * (lib/package-draft.js) tells Layer 2 that claim_context should be "the
 * same sentence (or a little more surrounding text)" — deliberately wider
 * than claim_text. For the identical run-on shape Round 1 was built to
 * handle (a comma/em-dash sentence with no internal period), an UNRELATED
 * row's claim_context can legitimately span across an adjacent, completely
 * different bracket, even when that row's own claim_text (Round 1's now-
 * narrow field) does not. When that happens,
 * `existingText.includes(instance.fullBracketText)` is trivially true
 * against claim_context alone, and the backstop wrongly marks the real
 * bracket "already covered" again. Confirmed with a deterministic repro
 * (TARS): a mold/habitability bracket sitting in a run-on sentence
 * immediately followed by unrelated parking-enforcement prose, one
 * legal_claim_reviews row whose claim_text is only the (correctly narrow)
 * parking prose but whose claim_context is a wider span that happens to
 * include the mold bracket's literal text — findMissingLegalClaimBracket-
 * Findings() returned [] instead of flagging the mold bracket.
 *
 * Fix: claim_context is no longer part of this decision AT ALL — only
 * claim_text (Round 1's narrow anchor) determines coverage. A wide field
 * can never be trusted to decide "does this row correspond to THIS specific
 * bracket," no matter how the comparison is phrased, because Layer 2's own
 * prompt explicitly permits claim_context to span content well beyond one
 * bracket's own claim. This does trade away the narrow case where Layer 2
 * correctly caught a bracket but chose a claim_text sub-span that doesn't
 * textually overlap the bracket's own literal text or description (e.g. it
 * paraphrased/pointed at surrounding prose instead of the bracket wrapper
 * itself) — that now produces a redundant structural_flag_scan row instead
 * of being silently treated as covered. Per this fix's own stated risk
 * direction (see findMissingLegalClaimBracketFindings()'s header and
 * filterNewLegalClaimFindings()'s own established precedent): an occasional
 * redundant review row is the correct failure mode to prefer over silently
 * mis-classifying an actual gap as covered — a duplicate row costs Peter/
 * Mason a few extra seconds of review; a silently-skipped bracket costs an
 * unreviewed legal claim reaching publication.
 */
function bracketInstanceIsAlreadyCovered(instance, existingRows) {
  return existingRows.some((r) => {
    const existingText = typeof r.claim_text === 'string' ? r.claim_text : '';
    if (!existingText) return false;
    if (instance.fullBracketText.includes(existingText)) return true;
    if (existingText.includes(instance.fullBracketText)) return true;
    if (instance.description) {
      if (existingText.includes(instance.description)) return true;
      if (instance.description.includes(existingText)) return true;
    }
    return false;
  });
}

async function findMissingLegalClaimBracketFindings(contentItemId, body) {
  if (!contentItemId) {
    throw new Error('findMissingLegalClaimBracketFindings() requires a contentItemId');
  }

  const instances = findLegalClaimBracketInstances(body);
  if (instances.length === 0) return [];

  // Only claim_text is selected — see bracketInstanceIsAlreadyCovered()'s
  // own comment for why claim_context is deliberately never read here
  // (round 2 of this bug: claim_context is too wide, by Layer 2's own
  // prompt design, to safely decide bracket coverage). Not selecting it at
  // all, rather than just not using it, is deliberate too — it removes the
  // temptation for a future edit to quietly start reading it again.
  const existingRows = await select(
    'legal_claim_reviews',
    `select=claim_text&content_item_id=eq.${contentItemId}`
  );

  const missing = [];
  const seenBracketText = new Set(); // avoid a duplicate fallback row if the identical bracket literally repeats within this same body
  for (const instance of instances) {
    if (seenBracketText.has(instance.fullBracketText)) continue;
    if (bracketInstanceIsAlreadyCovered(instance, existingRows)) continue;
    seenBracketText.add(instance.fullBracketText);
    missing.push({
      claimText: instance.description || instance.fullBracketText,
      context: instance.context,
      detectedBy: 'structural_flag_scan',
      sourceUrl: extractNearbySourceUrl(instance.context),
    });
  }
  return missing;
}

/**
 * ============================================================
 * reviewClaimAsMason() — Mason's automatic review pass
 * ============================================================
 * Runs Mason's own review framework (below) against ONE legal_claim_reviews
 * row: does the named source actually say what the claim states, is the
 * wording appropriately hedged, does it contradict an already-approved
 * compliance claim, what tier is the source, is it the kind of figure that
 * goes stale, does the source's scope match the claim's jurisdiction, and
 * does the claim carry any Fair Housing risk. Writes mason_finding,
 * mason_note, mason_reviewed_at (and source_tier, once Mason has actually
 * assessed it — see the migration's own comment on that column: "'unknown'
 * until Mason updates it").
 *
 * NEVER touches peter_decision, peter_edited_text, decided_by, or decided_at
 * — those stay null until Peter himself acts. Mason's finding is a strong
 * recommendation, never a publishing decision; see the migration's own
 * two-step rule (supabase/migrations/20260801000000_legal_claim_reviews.sql)
 * and GOVERNANCE.md's Fair Housing Standard, rule 7 ("Human in the loop for
 * every housing decision").
 *
 * Makes REAL web_search + web_fetch calls — a review that can't actually
 * check the cited source is theater, not review. Uses the beta web_fetch
 * tool (client.beta.messages.create, betas: ['web-fetch-2025-09-10']) so it
 * can retrieve the literal source_url named for this claim, not just search
 * around it. Deliberately does NOT reuse draft.js's/revise.js's
 * WEB_SEARCH_ALLOWED_DOMAINS allowlist — that list exists to gate which
 * GENERAL (non-legal) sources are trustworthy enough to cite in Rincon's own
 * published prose, a narrower question than "can Mason go look at whatever
 * source was actually named," which needs to reach any real source
 * (government sites, court sites, city ordinance pages) regardless of
 * whether it would also pass the content-citation allowlist.
 *
 * @param {string} claimId - legal_claim_reviews.id
 * @returns {Promise<{finding: string, sourceTier: string|null, note: string}>}
 */

const MASON_FINDINGS = ['CONFIRMED', 'NEEDS_SOURCE_CHECK', 'FLAG_FOR_ATTORNEY', 'REJECT'];
const MASON_SOURCE_TIERS = ['primary', 'secondary', 'unknown'];

function buildMasonSystemPrompt() {
  return `You are Mason, the automatic legal-claim review pass for Rincon Management, a
property management company operating in Ventura County, Southern California. Rincon's
content is meant to reflect California state law and, where a claim is scoped to a
specific city or county, the actual local ordinance for that jurisdiction — never a
generic, out-of-state, or made-up rule.

You are reviewing ONE specific sentence/clause that Rincon's content-drafting AI wrote
into an article, self-sourced (researched and cited by that AI, not drawn from Rincon's
pre-approved compliance_claims knowledge base). Your job is to check it before a human
(Peter, who owns this business) ever sees it — using REAL web research, not your own
memorized legal knowledge, which can be stale or wrong.

HARD LIMIT — state this plainly in every note you write, without exception: you are an
automated pass, not a bar-licensed attorney. You can check whether a cited source really
says what the claim says, whether the wording is appropriately hedged, and whether the
topic carries Fair Housing risk. You CANNOT confirm that current statute text is
accurate the way a licensed attorney could — never claim otherwise, and never let a
CONFIRMED finding read as "legally verified." Your note must always make this limit
explicit.

RUN THESE SEVEN CHECKS, IN ORDER, USING REAL TOOLS — NOT MEMORY:

1. SOURCE CHECK: If a real source_url is given (not the placeholder string described
   below), use web_fetch to actually retrieve that exact URL and read what it says. Does
   it really say what the claim states? If no source_url is given (it will read
   literally "(no source found in article text — flagged for review)"), use web_search
   to try to find a real primary source for the claim yourself before concluding none
   exists.

2. INTERNAL CONSISTENCY: Compare against the ALREADY-APPROVED compliance claims linked
   to this same article (provided below, if any). Does this new claim contradict one of
   them?

3. HEDGE-VS-CONFIDENCE: Does the claim's wording match how solid its sourcing actually
   is — properly hedged where sourcing is thin, vs. stated as flat unqualified fact only
   where that's actually warranted?

4. SOURCE TIER: Classify the best source you found/verified as "primary" (a government
   agency, a court, or the origin's own official page/document — e.g.
   leginfo.legislature.ca.gov, courts.ca.gov, oag.ca.gov, a city's own municipal code
   site) or "secondary" (a law firm blog, news article, aggregator, or other write-up
   ABOUT the primary source, not the source itself). If no usable source was found at
   all, this is "unknown".

5. STALENESS RISK: Is this the kind of figure that moves on a schedule (a dollar amount
   tied to CPI, an annually-adjusted fee, a rule that changes with each legislative
   session) such that it could already be stale even if it was accurate when the source
   was written?

6. JURISDICTION MATCH: Does the source actually support the scope the claim states —
   statewide California vs. a specific city/county ordinance vs. federal — and does that
   match Rincon's own jurisdiction (Ventura County, California)?

7. FAIR HOUSING ANGLE: Does the claim, or the way it's framed, touch a protected class
   (race, color, religion, sex, national origin, familial status, disability, source of
   income, or another state/local protected class), read like steering language, or land
   as an implicit threat to a tenant reading it?

OUTPUT — after you finish researching, decide exactly ONE of these four findings:

- CONFIRMED: a real source was checked (via web_fetch), it actually says what the claim
  states, the wording is appropriately hedged for that sourcing, and there is no Fair
  Housing concern.
- NEEDS_SOURCE_CHECK: fixable — describe CONCRETELY what's missing (e.g. "source is a
  secondary blog post, not the primary ordinance text," "claim states this as flat fact
  but the source itself hedges it," "this is a CPI-adjusted figure and the source is over
  a year old," "source supports statewide law but the claim states it as Ventura-County-
  specific").
- FLAG_FOR_ATTORNEY: high-stakes AND the automated checks above can't get it to solid
  ground — conflicting sources, no primary source found anywhere despite real searching,
  or an inherently high-consequence topic (e.g. eviction/unlawful-detainer procedure, a
  notice deadline that affects a legal right) where being wrong has real consequences.
- REJECT: unsupported after real research, contradicts an already-approved claim, or the
  language itself is Fair-Housing-risky.

Do all of your real research FIRST (web_search / web_fetch as needed — use them, don't
skip them; a review that never actually checks the source is worthless, not a review at
all). Do not narrate your research process in your response. When you are completely
done, respond with ONLY this exact final line, nothing before or after it, no markdown
code fence, valid JSON on one line:

MASON_REVIEW: {"finding": "CONFIRMED|NEEDS_SOURCE_CHECK|FLAG_FOR_ATTORNEY|REJECT", "source_tier": "primary|secondary|unknown", "note": "2-5 sentences explaining what you actually found and why, ending with the bar-licensed-attorney limitation stated plainly"}

CRITICAL — the "note" field must be valid JSON: if you quote source text verbatim inside
it, use single quotes ('...') around the quoted phrase instead of double quotes, or
backslash-escape any double quote character you do use (\\"). Never put a literal,
un-escaped " inside the note string, and never put a literal line break inside it — write
it as one continuous line.`;
}

function formatLinkedClaimsForMasonPrompt(linkedClaims) {
  if (!linkedClaims || linkedClaims.length === 0) {
    return '(No compliance claims are currently linked to this article to check against.)';
  }
  return linkedClaims
    .map(
      (c, i) =>
        `${i + 1}. claim_key: ${c.claim_key}\n   jurisdiction: ${c.jurisdiction_scope}\n   statement: ${c.statement}`
    )
    .join('\n\n');
}

function buildMasonUserPrompt({ claim, contentItem, linkedClaims }) {
  return `ARTICLE: "${contentItem ? contentItem.title : '(unknown title)'}" (${
    contentItem ? contentItem.content_type : 'unknown type'
  })

CLAIM TO REVIEW (exact text as it appears in the article):
${claim.claim_text}

SURROUNDING CONTEXT:
${claim.claim_context || '(none captured)'}

SOURCE URL NAMED FOR THIS CLAIM:
${claim.source_url}

DETECTED BY: ${claim.detected_by}

ALREADY-APPROVED COMPLIANCE CLAIMS LINKED TO THIS ARTICLE (check #2, internal
consistency — compare against these):
${formatLinkedClaimsForMasonPrompt(linkedClaims)}

Run all seven checks for real, using web_search/web_fetch as needed, then respond with
only the final MASON_REVIEW line as instructed.`;
}

// Simple concatenation (not draft.js's/revise.js's marker-based scheme) —
// this response is a short, structured review, not a long article body,
// and only the LAST "MASON_REVIEW: {...}" line is ever trusted (see
// parseMasonReview() below), so leftover research narration mixed into the
// earlier text blocks is harmless noise, not a body-corruption risk.
function concatenateBetaTextBlocks(content) {
  return (content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Find the JSON object that follows the LAST "MASON_REVIEW:" marker in
 * `text` and return it as a substring, tolerating two real, observed
 * response shapes that a naive "match to the end of the string" regex
 * cannot: (1) a markdown code fence wrapped around the object even though
 * the prompt says not to use one, and (2) trailing prose after the object
 * (the model adding a stray sentence after the line it was told to end
 * with). Root-caused live, 2026-08-18 (Q): the ORIGINAL parser here was
 * `/MASON_REVIEW:\s*(\{[\s\S]*\})\s*$/i` — anchored to require the object
 * to be the literal last thing in the response. Any trailing character
 * after the real closing brace (a code-fence backtick, one extra sentence)
 * broke that anchor and either (a) made the regex fail to match at all, or
 * (b) — the specific bug this function fixes — made the regex's greedy
 * `[\s\S]*` swallow past the object's TRUE closing brace looking for a
 * LATER one, capturing trailing garbage as if it were still inside the
 * JSON. JSON.parse() on that over-captured string is what produced the
 * exact bug report: "MASON_REVIEW JSON did not parse: Unterminated string
 * in JSON at position ..." — the parser reads past the real object into
 * unstructured prose and runs off the end of the string still "inside" the
 * last thing that looked like an open quote.
 *
 * Fix: instead of trusting the response to end exactly where the object
 * ends, scan forward from the object's own opening "{" and track brace
 * DEPTH — skipping over anything inside a JSON string (so a stray "{" or
 * "}" quoted from a real source's text, or inside `note`, never miscounts)
 * — until depth returns to zero. That is the object's real, true closing
 * brace, regardless of whatever markdown fence or extra sentence follows
 * it. If depth never returns to zero (the response was genuinely cut off
 * mid-object — a real max_tokens truncation, not a formatting quirk), this
 * throws, same as before: there is no complete object to recover.
 * @param {string} text
 * @returns {string} the exact JSON-object substring, unparsed
 */
function extractMasonReviewJson(text) {
  const raw = text || '';
  const markerRegex = /MASON_REVIEW:/gi;
  let markerMatch;
  let lastMarkerEnd = -1;
  while ((markerMatch = markerRegex.exec(raw))) {
    lastMarkerEnd = markerMatch.index + markerMatch[0].length;
  }
  if (lastMarkerEnd === -1) {
    throw new Error(
      'Mason review response did not contain the expected "MASON_REVIEW: {...}" line — ' +
        `cannot safely write a finding. Raw response tail: ${raw.slice(-500)}`
    );
  }

  // Skip whitespace, then a markdown code fence, if the model added one
  // despite being told not to (e.g. "```json\n{...}").
  let rest = raw.slice(lastMarkerEnd);
  rest = rest.replace(/^\s*```[a-zA-Z]*\s*/, '');

  const start = rest.indexOf('{');
  if (start === -1) {
    throw new Error(
      'Mason review response\'s "MASON_REVIEW:" line was not followed by a JSON object — ' +
        `cannot safely write a finding. Raw response tail: ${raw.slice(-500)}`
    );
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return rest.slice(start, i + 1);
    }
  }

  // depth never returned to zero — the object was cut off before its real
  // closing brace, almost always a max_tokens truncation.
  throw new Error(
    'Mason review response\'s "MASON_REVIEW:" JSON object was never closed (response likely ' +
      `truncated). Raw response tail: ${raw.slice(-500)}`
  );
}

/**
 * Parse and mechanically validate the "MASON_REVIEW: {...}" line — same
 * "point at structured output, verify it, never trust it blindly" contract
 * every other AI-output parser in this codebase follows (see
 * lib/package-draft.js's extractJsonArrayField()). Throws rather than
 * silently falling back to a default, on purpose: an unparseable or
 * out-of-enum response means Mason's review didn't actually produce a
 * trustworthy finding, and the DB's own CHECK constraint on mason_finding
 * would reject a bad value anyway — better to fail loudly here than write
 * something misleading.
 * @param {string} text
 * @returns {{finding: string, sourceTier: string|null, note: string}}
 */
function parseMasonReview(text) {
  const jsonText = extractMasonReviewJson(text);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Mason review response's MASON_REVIEW JSON did not parse: ${e.message}`);
  }

  const finding = parsed.finding;
  if (!MASON_FINDINGS.includes(finding)) {
    throw new Error(
      `Mason review returned an invalid finding "${finding}" — must be one of ${MASON_FINDINGS.join(', ')}`
    );
  }

  const note = typeof parsed.note === 'string' ? parsed.note.trim() : '';
  if (!note) {
    throw new Error('Mason review returned an empty note — a finding must always be explained.');
  }

  // A bad/missing source_tier is downgraded to null (leaving the column at
  // its existing DB value) rather than thrown — the finding/note are the
  // load-bearing part of this response, and the DB CHECK constraint would
  // reject an invalid value outright if written, so there's no safety
  // reason to fail the whole review over this one secondary field.
  let sourceTier = typeof parsed.source_tier === 'string' ? parsed.source_tier.trim().toLowerCase() : null;
  if (!MASON_SOURCE_TIERS.includes(sourceTier)) sourceTier = null;

  return { finding, note, sourceTier };
}

/**
 * Fetch the compliance claims already linked to a content item, for Mason's
 * internal-consistency check (framework check #2). Local, minimal copy of
 * the same query lib/revise.js's getLinkedClaims() already runs — not
 * imported from there, to avoid a require cycle (lib/revise.js already
 * requires THIS file for recomputeLegalReviewStatus()/
 * filterNewLegalClaimFindings()).
 * @param {string} contentItemId
 */
async function getLinkedClaimsForMason(contentItemId) {
  const links = await select(
    'content_item_compliance_claims',
    `select=compliance_claims(claim_key,statement,jurisdiction_scope,status)&content_item_id=eq.${contentItemId}`
  );
  return links.map((l) => l.compliance_claims).filter(Boolean);
}

// max_tokens for Mason's review call. Was 2048 — live-measured (Q,
// 2026-08-18, ~85 real API calls against this exact prompt/tool
// configuration) to run as high as ~1500 output tokens on a genuinely
// complex, multi-source, heavily-hedged review even when nothing goes
// wrong, leaving uncomfortably little headroom before the model's own
// research narration (which the prompt asks it to skip, but it doesn't
// reliably comply) plus a long `note` pushes past the cap and truncates the
// response mid-object. 6144 leaves roughly 4x that observed ceiling.
const MASON_REVIEW_MAX_TOKENS = 6144;

/**
 * One real attempt at Mason's review call for `claim` — makes the API call,
 * concatenates the text blocks, and parses the trailing MASON_REVIEW JSON.
 * Pulled out of reviewClaimAsMason() so that function can retry this exact
 * step once on failure (see its own comment) without re-fetching the claim/
 * content-item rows.
 * @returns {Promise<{finding: string, sourceTier: string|null, note: string}>}
 */
async function runMasonReviewAttempt({ claim, contentItem, linkedClaims }) {
  const client = getClient();
  const response = await client.beta.messages.create({
    model: MASON_MODEL,
    max_tokens: MASON_REVIEW_MAX_TOKENS,
    betas: ['web-fetch-2025-09-10'],
    tools: [
      // No allowed_domains restriction on either tool, unlike draft.js's/
      // revise.js's web_search — see this function's own header comment for
      // why Mason needs to be able to reach any real source, not just the
      // general-citation content allowlist.
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
      { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 4, max_content_tokens: 8000 },
    ],
    system: buildMasonSystemPrompt(),
    messages: [
      { role: 'user', content: buildMasonUserPrompt({ claim, contentItem, linkedClaims }) },
    ],
  });

  const text = concatenateBetaTextBlocks(response.content);
  return parseMasonReview(text);
}

/**
 * Run Mason's automatic review pass on one legal_claim_reviews row and write
 * the result back. See this function's own doc block above (right below the
 * module header comment) for the full design.
 *
 * RETRY-ONCE BACKSTOP (Q, 2026-08-18): the real fix for the "Unterminated
 * string in JSON" bug is extractMasonReviewJson()'s brace-depth-aware
 * extraction plus the bumped MASON_REVIEW_MAX_TOKENS above — see that
 * function's comment for the actual root cause. This retry is a SEPARATE,
 * deliberately narrow backstop on top of that fix, matching this codebase's
 * existing "never let one bad AI response permanently break a claim" stance
 * (same reasoning as draft.js's/revise.js's own per-row try/catch around
 * this exact call). It catches whatever residual failure the real fix
 * doesn't — most plausibly a genuinely malformed note field the model wrote
 * despite the escaping instruction above — and gives it exactly one fresh,
 * independent second sample before giving up. Retries the WHOLE call
 * (not just the parse) since a bad response is a property of that one
 * generation, not something a fresh attempt would inherit. Only ever two
 * total attempts — this is a backstop for a rare failure, not a poll loop.
 *
 * @param {string} claimId - legal_claim_reviews.id
 * @returns {Promise<{finding: string, sourceTier: string|null, note: string}>}
 */
async function reviewClaimAsMason(claimId) {
  if (!claimId) {
    throw new Error('reviewClaimAsMason() requires a claimId');
  }

  const rows = await select('legal_claim_reviews', `select=*&id=eq.${claimId}`);
  const claim = rows[0];
  if (!claim) {
    throw new Error(`No legal_claim_reviews row found for id ${claimId}`);
  }

  const [itemRows, linkedClaims] = await Promise.all([
    select('content_items', `select=id,title,content_type&id=eq.${claim.content_item_id}`),
    getLinkedClaimsForMason(claim.content_item_id),
  ]);
  const contentItem = itemRows[0] || null;

  let finding, sourceTier, note;
  try {
    ({ finding, sourceTier, note } = await runMasonReviewAttempt({ claim, contentItem, linkedClaims }));
  } catch (firstError) {
    console.warn(
      `[legal-review] Mason's review attempt 1/2 failed for legal_claim_reviews row ${claimId} — ` +
        `retrying once before giving up. ${firstError.message}`
    );
    ({ finding, sourceTier, note } = await runMasonReviewAttempt({ claim, contentItem, linkedClaims }));
  }

  // Deliberately does NOT touch peter_decision/peter_edited_text/decided_by/
  // decided_at — see this function's own header comment and the migration's
  // two-step rule. source_tier is written only when Mason actually returned
  // a valid one (see parseMasonReview()); mason_finding/mason_note/
  // mason_reviewed_at are always written together.
  await update('legal_claim_reviews', `id=eq.${claimId}`, {
    mason_finding: finding,
    mason_note: note,
    mason_reviewed_at: new Date().toISOString(),
    ...(sourceTier ? { source_tier: sourceTier } : {}),
  });

  return { finding, sourceTier, note };
}

module.exports = {
  recomputeLegalReviewStatus,
  filterNewLegalClaimFindings,
  findMissingLegalClaimBracketFindings,
  reviewClaimAsMason,
  RESOLVED_PETER_DECISIONS,
  MASON_FINDINGS,
  MASON_SOURCE_TIERS,
};
