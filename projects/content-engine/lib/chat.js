/**
 * lib/chat.js
 * A real back-and-forth chat on a draft's detail page, replacing the old
 * one-shot "leave a comment -> whole article gets rewritten" flow with
 * something that can tell the difference between Peter ASKING something and
 * Peter asking for a CHANGE.
 *
 * Every message in and out is a row in content_conversation_turns (migration
 * supabase/migrations/20260801000001_content_conversation_turns.sql) — this
 * file is the first code to ever read or write that table.
 *
 * THREE OUTCOMES:
 *   - QUESTION turns get a direct, honest plain-text answer. No article
 *     regeneration happens.
 *   - EDIT turns first try lib/scoped-edit.js's attemptScopedEdit() — a
 *     narrow "find one exact passage, verify it, swap in a replacement"
 *     path that never touches the rest of the article. If that comes back
 *     "not applicable" (not scoped-eligible, passage not found/ambiguous,
 *     the narration-safety check failed or flagged a problem, or anything
 *     else about it was uncertain), the EXISTING, UNCHANGED reviseContent()
 *     (lib/revise.js) runs instead — the same full-document rewrite Peter's
 *     old "Request Changes" button already triggers. This is the ONLY
 *     fallback for a failed scoped-edit attempt; Peter never sees an error
 *     about "couldn't find that text."
 *   - The resulting turn is tagged 'edit_scoped' or 'edit_full_regen'
 *     accordingly, so the chat log visibly distinguishes the two (see
 *     content-review/server.js's renderChatTurn()).
 *
 * Neither classifyIntent() nor answerQuestion() below calls detectLegalClaims()
 * or writes to legal_claim_reviews directly — that safety net runs inside
 * reviseContent() (unchanged) and, for a scoped edit, inside
 * attemptScopedEdit() itself (reusing the exact same shared functions), for
 * the EDIT path only.
 */

const { getClient } = require('./anthropic');
const { select, insert, update } = require('./supabase');
const { reviseContent, getLinkedClaims, getLinkedTopicIds } = require('./revise');
const { getInternalLinkCandidates, getGeneralInternalLinkCandidates } = require('./compliance');
const { attemptScopedEdit } = require('./scoped-edit');

const MODEL = 'claude-opus-4-8';

// ============================================================
// Persistence — content_conversation_turns
// ============================================================

async function getContentItem(contentItemId) {
  const rows = await select('content_items', `select=*&id=eq.${contentItemId}`);
  return rows[0] || null;
}

/**
 * Every turn for one draft, oldest first — the full conversation, as stored.
 * @param {string} contentItemId
 * @returns {Promise<object[]>}
 */
async function getConversationHistory(contentItemId) {
  return select(
    'content_conversation_turns',
    `select=*&content_item_id=eq.${contentItemId}&order=turn_number.asc`
  );
}

/**
 * Insert one turn row. sender_identity/resulting_content_edit_id default to
 * null (matching the migration's CHECK constraints: only a 'peter' turn may
 * carry sender_identity; only an 'ai' turn of turn_type <> 'question' may
 * carry resulting_content_edit_id).
 */
async function saveTurn({
  contentItemId,
  turnNumber,
  sender,
  senderIdentity = null,
  message,
  turnType,
  resultingContentEditId = null,
}) {
  const [row] = await insert('content_conversation_turns', {
    content_item_id: contentItemId,
    turn_number: turnNumber,
    sender,
    sender_identity: senderIdentity,
    message,
    turn_type: turnType,
    resulting_content_edit_id: resultingContentEditId,
  });
  return row;
}

/**
 * The content_edits row reviseContent() just wrote for this revision — used
 * to link the AI's chat turn back to it (resulting_content_edit_id). We
 * don't get this back from reviseContent() itself (its signature/return
 * shape is a black box we don't touch — see this build's own constraints),
 * so we re-read it the same way the rest of this app already does (e.g.
 * server.js's own edit-history query): the most recent field_changed='body'
 * row for this item is reviseContent()'s own write, since it always inserts
 * exactly one such row per call, right before returning.
 */
async function getLatestBodyContentEdit(contentItemId) {
  const rows = await select(
    'content_edits',
    `select=id&content_item_id=eq.${contentItemId}&field_changed=eq.body&order=created_at.desc&limit=1`
  );
  return rows[0] ? rows[0].id : null;
}

// ============================================================
// Conversation history -> prompt text, with the "collapse a resolved edit
// exchange to a short summary" rule the build spec calls for.
// ============================================================

/**
 * Turn the stored turns into a plain-text block to feed the intent
 * classifier and the direct-answer call.
 *
 * QUESTION exchanges: kept in FULL (both Peter's question and the AI's
 * answer) — these are usually short, and the spec explicitly says full text
 * stays for turns that didn't change anything.
 *
 * EDIT exchanges (edit_full_regen / edit_scoped): collapsed to ONE line —
 * the AI turn's own stored message, which IS the short summary of what
 * changed (see buildEditSummary() below for how that's produced). Peter's
 * original request text is deliberately NOT resent here once its edit has
 * landed and is reflected in the current draft body — resending the full
 * original ask every turn forever is exactly what the build spec says not
 * to do.
 *
 * Turns are paired by position (a Peter turn immediately followed by the AI
 * turn that responds to it) rather than by turn_number arithmetic, since
 * that's the only ordering guarantee turn_number actually gives (see the
 * migration's own comment: it's an explicit display/sort sequence, not
 * necessarily N/N+1 in pairs forever). A dangling Peter turn with no AI
 * response yet (e.g. a prior request crashed mid-flight) is still shown, so
 * it isn't silently lost from context.
 *
 * @param {object[]} turns - getConversationHistory()'s output, oldest first
 * @returns {string}
 */
function buildHistoryForPrompt(turns) {
  const lines = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.sender !== 'peter') continue; // rendered as part of its pair below
    const aiTurn = turns[i + 1] && turns[i + 1].sender === 'ai' ? turns[i + 1] : null;

    if (turn.turn_type === 'question') {
      lines.push(`Peter asked: ${turn.message}`);
      lines.push(aiTurn ? `You answered: ${aiTurn.message}` : '(no answer recorded yet)');
    } else {
      // edit_full_regen (this stage) or edit_scoped (future stage) — collapse.
      lines.push(
        aiTurn
          ? `Edit already made: ${aiTurn.message}`
          : `Peter requested an edit (not yet completed): ${turn.message}`
      );
    }
  }
  return lines.join('\n');
}

// ============================================================
// Edit-turn summary — deterministic, no extra Claude call. Reuses the exact
// "[NEEDS HUMAN REVIEW: ...]" flag format lib/revise.js's own hard rule 2
// already writes into the body, so "how many NEW flags did this revision
// add" is a plain, cheap regex diff, fed into one more small Claude call
// below that phrases it as a compact outcome sentence — NOT a template that
// quotes the original feedback text verbatim. That distinction matters: this
// summary is exactly what buildHistoryForPrompt() shows INSTEAD of the
// original request on every later turn (see build spec — resending the full
// original request forever is the thing being fixed), so it has to actually
// be a summary of the OUTCOME, not the original ask wrapped in a template
// string. A first version of this function did exactly that (wrapped
// feedbackMessage in quotes) and TARS-style live testing (2026-08-03) caught
// it immediately: the "collapsed" line still contained the entire original
// request verbatim, defeating the whole point.
// ============================================================

const NEEDS_HUMAN_REVIEW_FLAG_REGEX = /\[NEEDS HUMAN REVIEW:[^\]]*\]/g;

function extractNeedsHumanReviewFlags(text) {
  return (text || '').match(NEEDS_HUMAN_REVIEW_FLAG_REGEX) || [];
}

// Common connector/filler words that Pass 1's full-document rewrite is prone
// to inserting, dropping, or reordering around an OLD flag's real substance
// while addressing something else entirely — e.g. TARS's reproduction:
// "cite Civil Code Section 1950.5" reworded in passing to "and cite Civil
// Code Section 1950.5", two rounds after that flag was first created.
// Excluding these from the similarity comparison below is what makes that
// kind of cosmetic reword compare as "the same flag" rather than "new."
const FLAG_COMPARISON_STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'to', 'of', 'on', 'in', 'for', 'that', 'this',
  'is', 'are', 'was', 'were', 'it', 'its', 'as', 'by', 'with', 'or', 'be',
  'not', 'no', 'any', 'these', 'those', 'has', 'have', 'had', 'so', 'but',
  'yet', 'if', 'than', 'then', 'there', 'here', 'from', 'about',
]);

/**
 * Reduce one flag's text to the set of words that actually carry its
 * substance — lowercased, punctuation stripped (except '.' so a statute
 * number like "1950.5" survives as one token), filler words removed. Two
 * flags about the SAME underlying declined fact end up with (nearly) the
 * same word set even after Pass 1 reorders or lightly rewords the sentence
 * around it; two flags about genuinely DIFFERENT facts don't.
 */
function flagSignificantWords(flagText) {
  return new Set(
    (flagText || '')
      .toLowerCase()
      .replace(/[^a-z0-9.\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word && !FLAG_COMPARISON_STOPWORDS.has(word))
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
 * "30", "1950.5", "5000"). These are pulled out and compared separately from
 * overall word-overlap: two flags that are otherwise phrased almost
 * identically ("feedback asks for a 30-day notice period but no grounding
 * claim covers it" vs. "...a 60-day notice period...") share nearly every
 * word EXCEPT the one number that actually makes them two different facts.
 * Overall Jaccard similarity alone would score that pair as highly similar
 * and wrongly swallow the second, genuinely new flag as "just a reword" of
 * the first — the false negative this guard exists to prevent. Missing a
 * real new decline is worse than the original bug (an over-eager "new flag"
 * reads as over-cautious; a silently dropped one doesn't get reviewed at
 * all), so a numeric mismatch always overrides an otherwise-high word-overlap
 * score.
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

// How much word-overlap counts as "this is the same flag, just reworded"
// rather than "this is a genuinely different, new flag." Comfortably clears
// TARS's single-inserted-word repro case while still treating two flags
// about different specific facts (a notice period vs. a deposit cap, say) as
// distinct — those share at most a little boilerplate phrasing, nowhere near
// this bar. Only ever consulted after the numericTokens() guard above already
// confirmed the two flags agree on any specific numbers/citations involved.
const SAME_FLAG_SIMILARITY_THRESHOLD = 0.6;

/**
 * Flags present in `afterBody` that weren't already present — even in
 * reworded form — in `beforeBody`: newly declined-and-flagged-instead-of-
 * stated facts from THIS revision round specifically, not ones already
 * sitting in the draft from an earlier round that Pass 1's full-document
 * rewrite happened to reword in passing while addressing something else.
 *
 * Similarity-based (not exact string match) on purpose: Pass 1 rewrites the
 * WHOLE document every round, including paragraphs it wasn't asked to touch,
 * so an old flag can come back with incidental cosmetic rewording — same
 * substance, different words. An exact-string diff misreads that reworded
 * OLD flag as newly created THIS round, and summarizeEdit() then wrongly
 * attributes an old, already-resolved decline to the current turn's summary
 * (TARS, 2026-08-03 — an edit turn that only shortened one unrelated
 * paragraph produced a stored summary claiming it had just flagged a
 * notice-period, deposit-cap, and Civil Code citation that had actually all
 * been flagged 2 rounds earlier).
 *
 * Still only a set-based comparison, not an exact multiset — good enough
 * here since this only feeds a one-line summary, not a review queue
 * (legal_claim_reviews is the real, exact record of these — see
 * lib/legal-review.js).
 */
function extractNewNeedsHumanReviewFlags(beforeBody, afterBody) {
  const beforeWordSets = extractNeedsHumanReviewFlags(beforeBody).map(flagSignificantWords);
  const seen = new Set();
  const newOnes = [];
  for (const flag of extractNeedsHumanReviewFlags(afterBody)) {
    if (seen.has(flag)) continue;
    const afterWords = flagSignificantWords(flag);
    const afterNumbers = numericTokens(afterWords);
    const isRewordOfExistingFlag = beforeWordSets.some(
      (beforeWords) =>
        sameTokenSet(numericTokens(beforeWords), afterNumbers) &&
        jaccardSimilarity(beforeWords, afterWords) >= SAME_FLAG_SIMILARITY_THRESHOLD
    );
    if (isRewordOfExistingFlag) continue;
    seen.add(flag);
    newOnes.push(flag);
  }
  return newOnes;
}

function buildEditSummarySystemPrompt() {
  return `You write ONE short outcome sentence (two, only if genuinely
needed) describing what just changed in an article after an editor's
request was applied.

This sentence is stored permanently and shown INSTEAD of the original
request text in every later turn of this conversation — so it must stand on
its own as a description of the OUTCOME, not a repetition of the ask.

HARD RULES:
1. Describe what was done, in past tense, third person (e.g. "Added a
   paragraph explaining X.") — never quote or closely paraphrase the
   original request sentence-for-sentence; compress it to its substance.
2. If any NEWLY FLAGGED ITEMS are listed below, mention plainly that
   something was flagged/declined instead of stated as fact, and briefly why
   — this is often the most important part of the summary; do not omit it.
3. Keep it to 1-2 short sentences, plain text, no markdown, no labels.
4. Output ONLY the sentence(s) — nothing before or after.`;
}

function buildEditSummaryUserPrompt({ feedbackMessage, newFlags }) {
  const flagsSection =
    newFlags.length > 0
      ? `NEWLY FLAGGED ITEMS (declined — no grounding claim on this draft covers
these, so they were flagged instead of stated as fact):
${newFlags.map((f, i) => `${i + 1}. ${f}`).join('\n')}

`
      : '';

  return `ORIGINAL REQUEST THAT WAS JUST ADDRESSED (for your reference only —
do not quote or closely paraphrase it in your summary):
${feedbackMessage}

${flagsSection}Write the short outcome summary now, following the rules above.`;
}

/**
 * Produce the short outcome summary stored as the AI turn's own message for
 * an edit_full_regen exchange — this IS the "collapsed" context
 * buildHistoryForPrompt() carries forward for this exchange from now on.
 * One more small Claude call (same "cheap, fast, judgment-sized" budget as
 * classifyIntent()) rather than a template, specifically so the original
 * request text is genuinely compressed/paraphrased rather than quoted back
 * verbatim — see this section's own header comment for why a template-based
 * version was tried and rejected.
 * @param {{feedbackMessage: string, beforeBody: string, afterBody: string}} opts
 * @returns {Promise<string>}
 */
async function summarizeEdit({ feedbackMessage, beforeBody, afterBody }) {
  const newFlags = extractNewNeedsHumanReviewFlags(beforeBody, afterBody);

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 150,
    system: buildEditSummarySystemPrompt(),
    messages: [
      { role: 'user', content: buildEditSummaryUserPrompt({ feedbackMessage, newFlags }) },
    ],
  });
  const textBlock = (response.content || []).find((b) => b && b.type === 'text' && typeof b.text === 'string');
  const summary = textBlock ? textBlock.text.trim() : '';
  if (summary) return summary;

  // Fallback if the call produced nothing usable — still must never be the
  // original request text verbatim, per this function's own contract.
  return newFlags.length > 0
    ? `Revision completed — ${newFlags.length} item${newFlags.length === 1 ? '' : 's'} flagged for human review (no grounding claim covers ${newFlags.length === 1 ? 'it' : 'them'} yet).`
    : 'Revision completed.';
}

// ============================================================
// Intent classification — small, fast, judgment-only Claude call. Same
// "ask the model a structured question, parse strictly, fall back safely"
// shape as lib/package-draft.js's LEAKED_OPENING_NARRATION field, scaled
// down to a plain one-line label instead of a verified text span (there's
// no span to verify here — it's a classification, not an extraction).
// ============================================================

function buildClassifierSystemPrompt() {
  return `You are an intent classifier for Rincon Management's content-review
chat tool. Peter (the property manager who owns this draft) is chatting with
you about ONE specific article draft. Your only job is to decide whether his
LATEST message is a QUESTION or an EDIT request.

QUESTION — he is asking something and expects an explanation in return, not
a changed article: a question about the article, about why it does or
doesn't say something, about how the process/rules work, or pushback like
"why won't you use my sources" or "why did you leave that out." These are
asking WHY, not asking you to change anything yet.

EDIT — he is asking for the article itself to be changed: add something,
remove something, reword something, restructure something, address a piece
of feedback.

If his message both asks something AND requests a change in the same
breath, classify it as EDIT — the point of the message is that the article
should be different afterward.

Output ONLY one line, exactly one of:

INTENT: QUESTION
INTENT: EDIT

No other text before or after it.`;
}

function buildClassifierUserPrompt({ message, currentBody, historyForPrompt }) {
  return `CURRENT ARTICLE BODY:
${currentBody}

CONVERSATION SO FAR (oldest first; a completed edit exchange is shown as a
short summary of what changed, not the original request text):
${historyForPrompt || '(no earlier messages on this draft)'}

PETER'S NEW MESSAGE:
${message}

Classify PETER'S NEW MESSAGE above. Output only the single line described in
your instructions.`;
}

function parseIntent(text, contentItemId) {
  const match = (text || '').match(/INTENT:\s*(QUESTION|EDIT)/i);
  if (!match) {
    // Real anomaly, not a formatting quirk — logged so it's traceable rather
    // than silently guessed at. Defaults to EDIT: an unnecessary
    // regeneration (safe, reversible, nothing auto-published — see
    // reviseContent()'s own governance notes) is a smaller failure than
    // silently never acting on a real edit request because it got answered
    // as a question instead.
    console.warn(
      `[chat.js] classifyIntent(): could not parse INTENT from model response` +
        `${contentItemId ? ` for content_item ${contentItemId}` : ''} — defaulting to EDIT. ` +
        `Raw response: ${JSON.stringify(text)}`
    );
    return 'EDIT';
  }
  return match[1].toUpperCase();
}

async function classifyIntent({ message, currentBody, historyForPrompt, contentItemId }) {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 30, // one short line — this is a judgment call, not a rewrite
    system: buildClassifierSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildClassifierUserPrompt({ message, currentBody, historyForPrompt }),
      },
    ],
  });
  const textBlock = (response.content || []).find((b) => b && b.type === 'text' && typeof b.text === 'string');
  return parseIntent(textBlock ? textBlock.text : '', contentItemId);
}

// ============================================================
// Direct-answer path (QUESTION) — one more small Claude call. Governed by
// the SAME legal-grounding hard rule reviseContent()'s own prompt uses
// (lib/revise.js's buildSystemPrompt() hard rule 1/2), reframed for
// answering rather than writing: only ever state a specific legal fact if
// it's already in this draft's linked GROUNDING CLAIMS, and be HONEST when
// a hard rule/limitation is the real reason something isn't happening —
// this is the fix for the real "why are you not using them" gap this build
// exists for.
// ============================================================

function formatClaimsForAnswerPrompt(claims) {
  if (!claims || claims.length === 0) {
    return '(No compliance claims are currently linked to this draft — it is not grounded in any pre-approved legal facts. If Peter is asking about a legal fact, be honest that none is currently linked/approved for this draft rather than guessing or inventing one.)';
  }
  return claims
    .map((c, i) => {
      const flag = c.status === 'NEEDS_HUMAN_REVIEW' ? ' [STATUS: NEEDS_HUMAN_REVIEW]' : '';
      return (
        `${i + 1}. claim_key: ${c.claim_key}${flag}\n` +
        `   jurisdiction: ${c.jurisdiction_scope}\n` +
        `   statement: ${c.statement}`
      );
    })
    .join('\n\n');
}

function buildAnswerSystemPrompt() {
  return `You are answering Peter's question about ONE specific article draft
for Rincon Management, a Southern California property management company.
Peter owns this business and is asking you something directly in a chat
about this draft — he is not asking you to change the article right now,
just to answer him.

HARD RULES:

1. Answer honestly and directly. If the honest answer is that a hard rule or
   limitation is what's actually stopping something — for example, if Peter
   asks why sources or facts he provided aren't being used, the honest
   answer may be that you may only state a specific legal fact if it is
   already in this draft's approved GROUNDING CLAIMS list below, and text
   pasted into chat isn't automatically added to that list — say so plainly.
   Do not deflect, hedge vaguely, or give a non-answer.

2. You may only state a specific legal fact (a rule, a deadline, a dollar
   amount, a percentage, a notice period, a citation) in your answer if it
   is explicitly present in the GROUNDING CLAIMS section below. If Peter
   asks you to confirm, restate, or use a legal fact that isn't covered
   there, say plainly that you don't have it as an approved fact for this
   draft — do not guess or use outside knowledge of California or Ventura
   County law.

3. Do not rewrite, edit, or restate the article. Your response is a direct
   answer to Peter's question ONLY — plain conversational text, no
   Markdown headings, no article structure.

4. Keep your answer focused — a few sentences to a short paragraph is
   usually enough, unless the question genuinely needs more.

5. Never invent a citation, statute number, or ordinance number that isn't
   in the grounding claims.

6. You DO have real, live access to Rincon's own past published blog posts
   for internal linking on this draft — see the INTERNAL LINK CANDIDATES
   section below. That section is the actual, current output of the same
   internal-linking lookup the drafting/revision system itself uses to
   build the article's "Related Reading" section. If Peter asks why the
   article isn't linking to Rincon's own past posts, or asks what's
   available to link to, answer using that real list — name actual
   candidate titles/URLs when there are any. Never say you don't have a
   connection to Rincon's article database, can't "look" at or retrieve
   past posts, or can't browse what's published — none of that is true; you
   are being given the real, current answer below.

7. More generally: never assert a specific, confident claim about what
   data, systems, or capabilities you do or do not have access to unless
   it's clearly established by what's actually given to you in this prompt.
   If Peter asks about some capability this prompt doesn't cover, the
   honest answer is to say plainly that you don't have clear information on
   that from here — and suggest what he could do instead (check the system
   directly, or ask you to look at something specific) — rather than
   inventing a specific-sounding technical explanation for why something
   isn't happening. A confident, plausible-sounding, wrong answer about
   your own architecture is worse than admitting you're not sure. This rule
   is about genuinely ABSENT information — see rule 8 below for the one
   thing that is never absent: the article's current text.

8. The CURRENT ARTICLE BODY given to you below is not a log, a note that
   "edits were applied," or a cached/stale snapshot — it is the actual live
   article exactly as it is stored in the database right now, re-fetched
   fresh at the moment this question is being asked, every single time,
   with no delay and no separate "editor view" it could be out of sync
   with. When Peter asks whether a change landed, whether the article
   currently says or does something, or what the article currently looks
   like, you already have the real answer sitting in this prompt: read the
   CURRENT ARTICLE BODY below and answer directly from it, quoting or
   describing the specific relevant part rather than speaking in the
   abstract. Do not tell Peter to go check the main article or editor
   himself to find out what it currently says, and do not express
   uncertainty about whether you have "live-view capability" — you are
   already looking at the live text. Rule 7's caution about unclear
   capabilities does not apply here: this is the one capability this prompt
   always, clearly gives you.

Output your answer as plain text only — no preamble like "Sure, here's the
answer," just the answer itself.`;
}

/**
 * Format this draft's real internal-linking candidates (from
 * lib/compliance.js's getInternalLinkCandidates()/
 * getGeneralInternalLinkCandidates() — the same lookup draft.js/revise.js
 * use to build the "Related Reading" section) for the answer prompt, so the
 * model can give a real, specific answer instead of guessing or claiming it
 * has no access to Rincon's past posts.
 * @param {{title: string, published_url: string}[]} candidates
 */
function formatInternalLinkCandidatesForAnswerPrompt(candidates) {
  if (!candidates || candidates.length === 0) {
    return '(This lookup ran for real just now and found no internal-link candidates currently available for this specific draft — either none of Rincon\'s other published posts overlap closely enough with this draft\'s topic/keywords, or there aren\'t enough qualifying published posts yet. This is the real, current result, not a missing feature — say so plainly if Peter asks, rather than claiming you lack access to the article database.)';
  }
  return candidates
    .map((c, i) => `${i + 1}. "${c.title}" — ${c.published_url}`)
    .join('\n');
}

function buildAnswerUserPrompt({ message, currentBody, historyForPrompt, claims, internalLinkCandidates }) {
  return `CURRENT ARTICLE BODY — this is the real, live article text exactly
as stored in the database right now, fetched fresh for this exact question
(not a cached copy, not a log of "an edit was applied"). If Peter asks
whether a change landed or what the article currently says, this is the real
answer — read it and reference it directly (see hard rule 8). This section
is for your reference only in the sense that you should not repeat or
rewrite the whole thing back to him — do not treat that as a reason to avoid
naming what's actually in it:
${currentBody}

GROUNDING CLAIMS already linked to this draft (the only legal facts you may
state):
${formatClaimsForAnswerPrompt(claims)}

INTERNAL LINK CANDIDATES for this draft (real, published Rincon posts the
internal-linking system currently has available for THIS article — see hard
rule 6):
${formatInternalLinkCandidatesForAnswerPrompt(internalLinkCandidates)}

CONVERSATION SO FAR (oldest first; a completed edit exchange is shown as a
short summary of what changed):
${historyForPrompt || '(no earlier messages on this draft)'}

PETER'S QUESTION:
${message}

Answer Peter's question now, following the hard rules above.`;
}

async function answerQuestion({ message, currentBody, historyForPrompt, claims, internalLinkCandidates }) {
  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildAnswerSystemPrompt(),
    messages: [
      {
        role: 'user',
        content: buildAnswerUserPrompt({ message, currentBody, historyForPrompt, claims, internalLinkCandidates }),
      },
    ],
  });
  const textBlock = (response.content || []).find((b) => b && b.type === 'text' && typeof b.text === 'string');
  const answer = textBlock ? textBlock.text.trim() : '';
  if (!answer) {
    throw new Error('Claude response contained no answer text');
  }
  return answer;
}

// ============================================================
// Orchestrator — what the new server.js route calls.
// ============================================================

/**
 * Handle one new chat message on a draft: classify it, then either answer it
 * directly (QUESTION), apply a narrow scoped edit (EDIT, via
 * lib/scoped-edit.js's attemptScopedEdit()), or run the existing
 * full-regeneration revision pipeline (EDIT, when a scoped edit wasn't
 * applicable) — saving Peter's turn and the AI's response as a matched pair,
 * both tagged with whichever turn_type actually happened
 * ('question' | 'edit_scoped' | 'edit_full_regen').
 *
 * @param {object} opts
 * @param {string} opts.contentItemId
 * @param {string} opts.message - Peter's new chat message
 * @param {string} opts.senderIdentity - Peter's real identifier (his email —
 *   req.session.userEmail in content-review), stored on his turn
 * @returns {Promise<{intent: 'QUESTION'|'EDIT', peterTurn: object, aiTurn: object, contentItem: object, answer?: string, summary?: string}>}
 */
async function handleChatMessage({ contentItemId, message, senderIdentity }) {
  if (!contentItemId) throw new Error('contentItemId is required');
  if (!message || !message.trim()) throw new Error('message is required');
  if (!senderIdentity) throw new Error('senderIdentity is required to attribute this message');

  const item = await getContentItem(contentItemId);
  if (!item) throw new Error(`content_item ${contentItemId} not found`);

  const trimmedMessage = message.trim();
  const existingTurns = await getConversationHistory(contentItemId);
  const historyForPrompt = buildHistoryForPrompt(existingTurns);
  const peterTurnNumber =
    existingTurns.length > 0 ? existingTurns[existingTurns.length - 1].turn_number + 1 : 1;
  const aiTurnNumber = peterTurnNumber + 1;

  const intent = await classifyIntent({
    message: trimmedMessage,
    currentBody: item.body || '',
    historyForPrompt,
    contentItemId,
  });

  if (intent === 'QUESTION') {
    const peterTurn = await saveTurn({
      contentItemId,
      turnNumber: peterTurnNumber,
      sender: 'peter',
      senderIdentity,
      message: trimmedMessage,
      turnType: 'question',
    });

    const [claims, topicIds] = await Promise.all([
      getLinkedClaims(contentItemId),
      getLinkedTopicIds(contentItemId),
    ]);
    // Same hasTopics branch reviseContent() uses for this same lookup
    // (lib/revise.js) — items tagged with a legal topic get the topic-based
    // candidate lookup; the ~4/5 of articles with no legal topic fall back
    // to keyword-overlap scoring against title+body instead of getting no
    // candidates at all.
    const hasTopics = topicIds.length > 0;
    const internalLinkCandidates = hasTopics
      ? await getInternalLinkCandidates(topicIds, contentItemId)
      : await getGeneralInternalLinkCandidates(item.title || '', item.body || '', contentItemId);

    const answer = await answerQuestion({
      message: trimmedMessage,
      currentBody: item.body || '',
      historyForPrompt,
      claims,
      internalLinkCandidates,
    });

    const aiTurn = await saveTurn({
      contentItemId,
      turnNumber: aiTurnNumber,
      sender: 'ai',
      message: answer,
      turnType: 'question',
    });

    return { intent: 'QUESTION', answer, peterTurn, aiTurn, contentItem: item };
  }

  // EDIT — the migration's own design rule is that turn_type describes the
  // WHOLE EXCHANGE (Peter's turn and the AI's response both carry the same
  // value), so Peter's turn can't be saved with its final turn_type until we
  // know whether this lands as a scoped edit or a full regeneration. Try the
  // narrow scoped-edit path FIRST (lib/scoped-edit.js) — it makes no writes
  // at all unless it's actually going to succeed (see that file's own
  // header comment), so attempting it here has no effect on the untouched
  // full-regen fallback below if it comes back "not applicable."
  const scopedResult = await attemptScopedEdit({
    contentItemId,
    message: trimmedMessage,
    currentBody: item.body || '',
    editedBy: `AI (scoped edit via chat, requested by ${senderIdentity})`,
  });

  if (scopedResult.applicable) {
    const peterTurn = await saveTurn({
      contentItemId,
      turnNumber: peterTurnNumber,
      sender: 'peter',
      senderIdentity,
      message: trimmedMessage,
      turnType: 'edit_scoped',
    });

    const aiTurn = await saveTurn({
      contentItemId,
      turnNumber: aiTurnNumber,
      sender: 'ai',
      message: scopedResult.summaryMessage,
      turnType: 'edit_scoped',
      resultingContentEditId: scopedResult.resultingContentEditId,
    });

    return { intent: 'EDIT', summary: scopedResult.summaryMessage, peterTurn, aiTurn, contentItem: scopedResult.contentItem };
  }

  // Not scoped-eligible (or anything about that attempt was uncertain) —
  // fall through to the EXISTING, UNCHANGED full-regeneration path. This is
  // the ONLY fallback; there is no separate "ask Peter to clarify" path.
  const peterTurn = await saveTurn({
    contentItemId,
    turnNumber: peterTurnNumber,
    sender: 'peter',
    senderIdentity,
    message: trimmedMessage,
    turnType: 'edit_full_regen',
  });

  // reviseContent() reads its own feedback history from content_edits (rows
  // where field_changed='status' and after_text='needs_changes'), so this
  // chat message has to be logged the exact same way the existing "Request
  // Changes" button already logs it before calling reviseContent() —
  // otherwise reviseContent() would see zero feedback and throw.
  await update('content_items', `id=eq.${contentItemId}`, { status: 'needs_changes' });
  await insert('content_edits', {
    content_item_id: contentItemId,
    edited_by: senderIdentity,
    field_changed: 'status',
    before_text: null,
    after_text: 'needs_changes',
    edit_note: trimmedMessage,
  });

  const { contentItem: revisedItem } = await reviseContent({
    contentItemId,
    currentTitle: item.title,
    currentBody: item.body,
  });

  const resultingContentEditId = await getLatestBodyContentEdit(contentItemId);
  const summary = await summarizeEdit({
    feedbackMessage: trimmedMessage,
    beforeBody: item.body || '',
    afterBody: revisedItem.body || '',
  });

  const aiTurn = await saveTurn({
    contentItemId,
    turnNumber: aiTurnNumber,
    sender: 'ai',
    message: summary,
    turnType: 'edit_full_regen',
    resultingContentEditId,
  });

  return { intent: 'EDIT', summary, peterTurn, aiTurn, contentItem: revisedItem };
}

module.exports = {
  handleChatMessage,
  classifyIntent,
  answerQuestion,
  getConversationHistory,
  buildHistoryForPrompt,
  summarizeEdit,
  saveTurn,
  extractNewNeedsHumanReviewFlags,
};
