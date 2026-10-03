/**
 * lib/standalone-captions.js
 * Generates Facebook/LinkedIn/Instagram captions for a social-only post that
 * has no parent blog post — Peter submits a topic/brief directly (via
 * /social/new in content-review) instead of writing a full article first.
 *
 * This is a sibling to lib/captions.js, not a modification of it:
 * lib/captions.js derives captions FROM an existing approved blog_post's
 * title/body. This module drafts directly from a title/brief, the same way
 * lib/draft.js drafts a blog post — grounded only in compliance_claims,
 * flagging NEEDS_HUMAN_REVIEW inline, never inventing legal facts. The
 * inspiration-piece (style-reference-only) handling mirrors draft.js as well.
 *
 * Writes three rows into social_captions with content_item_id = NULL (no
 * parent content_items row exists), status='pending', all three rows sharing
 * one batch_id (grouping key) and topic_label (human-readable label for the
 * review page) — see the ALTER TABLE that added those two columns.
 */

const { getClient } = require('./anthropic');
const { getGroundingClaims } = require('./compliance');
const { getActiveBrandGuide, formatBrandGuideForPrompt, brandGuideSystemRule } = require('./brand-guide');
const { insert } = require('./supabase');
const crypto = require('crypto');

const MODEL = 'claude-opus-4-8';
const PLATFORMS = ['facebook', 'linkedin', 'instagram'];

function formatClaimsForPrompt(claims) {
  if (claims.length === 0) {
    return '(No matching compliance claims were found in the knowledge base for this topic.)';
  }
  return claims
    .map((c, i) => {
      const flag = c.status === 'NEEDS_HUMAN_REVIEW' ? ' [STATUS: NEEDS_HUMAN_REVIEW]' : '';
      return (
        `${i + 1}. claim_key: ${c.claim_key}${flag}\n` +
        `   jurisdiction: ${c.jurisdiction_scope}\n` +
        `   confidence: ${c.confidence}\n` +
        `   statement: ${c.statement}` +
        (c.notes ? `\n   notes: ${c.notes}` : '')
      );
    })
    .join('\n\n');
}

function formatInspirationForPrompt(inspirationPiece) {
  return `INSPIRATION PIECE (STYLE REFERENCE ONLY — READ THIS CAREFULLY):
The editor has pasted in an example post below because they want these
captions' voice and tone modeled after it. Study its rhythm, formality, and
overall shape, and write in a similar style.

Do NOT do any of the following with this inspiration piece:
- Do not treat anything it says as a fact, statistic, rule, deadline, dollar
  amount, or legal claim you can use in the captions.
- Do not copy or paraphrase specific claims, numbers, examples, or case
  details from it.
- Do not treat it as a second source of grounding alongside the GROUNDING
  CLAIMS section. That section (if present) remains the ONLY source of legal
  facts — this inspiration piece does not change that.

--- START INSPIRATION PIECE (style reference only, not a factual source) ---
${inspirationPiece}
--- END INSPIRATION PIECE ---

`;
}

function buildSystemPrompt({ hasTopics, hasInspirationPiece, hasBrandGuide = false }) {
  const roleLine = `You write social media captions for Rincon Management, a
property management company in Southern California. Unlike most captions you
write, this post has NO underlying blog post — you are writing directly from
a topic/brief the editor gave you.`;

  const hardRules = hasTopics
    ? `HARD RULES — follow these exactly:

1. You may only state a specific legal fact (a rule, a deadline, a dollar
   amount, a percentage, a notice period, a citation) if it is explicitly
   present in the "GROUNDING CLAIMS" section of this prompt. Do not use
   outside knowledge of California law, even if you believe you know the
   correct rule. If the grounding claims don't cover something the topic
   needs, leave that detail out rather than filling the gap from memory.

2. If a grounding claim you used has "[STATUS: NEEDS_HUMAN_REVIEW]" next to
   it, you MUST include a clearly visible flag in the caption itself where
   that fact appears, using this exact format inline:
   "[NEEDS HUMAN REVIEW: <short reason>]"
   Do not silently smooth over or omit these flags.

3. Do not fabricate a citation, statute number, or ordinance number that
   isn't in the grounding claims.

4. Never include any tenant's or owner's real name, address, or other
   identifying detail.

5. Do not include a "post this now" or auto-publish instruction, or any call
   to action implying this will be posted automatically — a human copies each
   caption out manually.`
    : `HARD RULES — follow these exactly:

1. This topic has no grounding claims provided, so do not state specific
   legal facts (a rule, a deadline, a dollar amount, a percentage, a notice
   period, a citation, a statute or ordinance number) as if they were
   verified California law. Keep captions to general, practical, non-legal
   content (e.g. maintenance tips, seasonal reminders, community notes). If
   the brief drifts into something that would need a specific legal fact,
   leave it out rather than stating it yourself.

2. Never include any tenant's or owner's real name, address, or other
   identifying detail.

3. Do not include a "post this now" or auto-publish instruction, or any call
   to action implying this will be posted automatically — a human copies each
   caption out manually.`;

  // Deliberately an unnumbered bullet rather than continuing the numbered
  // list above, same reasoning as draft.js: that list's numbers are
  // hardcoded per branch, so a plain bullet can't drift out of sync if a
  // hard rule is later added/removed. Shared with draft.js/revise.js
  // (lib/brand-guide.js) so the wording never drifts.
  const brandGuideRule = hasBrandGuide
    ? brandGuideSystemRule({
        inspirationNote: hasInspirationPiece
          ? ' If an inspiration piece is also provided below and it ever suggests different style choices than this guide, follow the inspiration piece for these captions — it was chosen specifically for this post.'
          : '',
      })
    : '';

  const inspirationRule = hasInspirationPiece
    ? `

${hasTopics ? '6' : '4'}. The prompt below includes an INSPIRATION PIECE pasted in by the editor.
   It is a STYLE REFERENCE ONLY. Mimic its voice and tone — never its
   content. Every legal fact must still come only from the GROUNDING CLAIMS
   section (or, if there are none, no specific legal facts should be stated
   at all, per the rules above).`
    : '';

  return `${roleLine}

${hardRules}${brandGuideRule}${inspirationRule}

Match tone to platform: LinkedIn is professional/informative, Facebook is
warm and community-oriented, Instagram is short and visual-first (assume a
graphic will accompany it). This is marketing/educational content, not legal
advice.`;
}

function buildUserPrompt({ title, brief, claims, hasTopics, inspirationPiece, brandGuideContent }) {
  const groundingSection = hasTopics
    ? `GROUNDING CLAIMS (the only source of legal facts you may use):
${formatClaimsForPrompt(claims)}

`
    : '';

  const brandGuideSection = brandGuideContent ? formatBrandGuideForPrompt(brandGuideContent) : '';

  const inspirationSection = inspirationPiece ? formatInspirationForPrompt(inspirationPiece) : '';

  const claimsInstruction = hasTopics
    ? `After the three captions, on its own line, list every claim_key you
actually relied on in this exact format:

CLAIMS_USED: [claim_key_1, claim_key_2, ...]

If you used no grounding claims, write "CLAIMS_USED: []".`
    : `This post has no legal topics selected, so no grounding claims apply.
After the three captions, on its own line, write exactly:

CLAIMS_USED: []`;

  return `Write one social media caption for each of Facebook, LinkedIn, and
Instagram about the following topic. There is no underlying blog post — write
directly from the topic and brief below.

TOPIC: ${title}

BRIEF:
${brief}

${groundingSection}${brandGuideSection}${inspirationSection}Respond in exactly this format, with nothing else before or after
(the CLAIMS_USED line goes last):

FACEBOOK:
<caption text>

LINKEDIN:
<caption text>

INSTAGRAM:
<caption text>

${claimsInstruction}`;
}

function parseCaptions(text) {
  const result = {};
  for (const platform of PLATFORMS) {
    const label = platform.toUpperCase();
    const regex = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`, 'i');
    const match = text.match(regex);
    if (match) {
      result[platform] = match[1].trim();
    }
  }
  return result;
}

/**
 * Parse the trailing "CLAIMS_USED: [...]" line, same convention as draft.js.
 */
function extractClaimsUsed(text) {
  const match = text.match(/CLAIMS_USED:\s*\[([^\]]*)\]\s*$/i);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/**
 * Generate standalone social captions (no parent blog post).
 *
 * @param {object} opts
 * @param {string} opts.title - working title/topic, becomes topic_label
 * @param {string} opts.brief - what the post should cover
 * @param {string[]} [opts.topicKeywords] - optional legal topic tags for grounding
 * @param {string} [opts.inspirationPiece] - optional one-off style reference, never persisted
 * @returns {Promise<{captions: object[], batchId: string, claimsFlaggedForReview: object[]}>}
 */
async function generateStandaloneCaptions({
  title,
  brief,
  topicKeywords = [],
  inspirationPiece = null,
}) {
  if (!title || !title.trim()) throw new Error('title is required');
  if (!brief || !brief.trim()) throw new Error('brief is required');
  if (!Array.isArray(topicKeywords)) {
    throw new Error('topicKeywords must be an array of strings (or omitted/empty)');
  }

  const hasTopics = topicKeywords.length > 0;
  const [claims, brandGuide] = await Promise.all([
    hasTopics ? getGroundingClaims(topicKeywords).then((r) => r.claims) : Promise.resolve([]),
    // Persistent voice/style guidance saved in the database — independent of
    // topics/grounding. Returns null if Peter hasn't uploaded one yet, in
    // which case caption generation is unaffected (unchanged behavior).
    getActiveBrandGuide(),
  ]);
  const brandGuideContent = brandGuide ? brandGuide.content : null;

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1536,
    system: buildSystemPrompt({
      hasTopics,
      hasInspirationPiece: Boolean(inspirationPiece),
      hasBrandGuide: Boolean(brandGuideContent),
    }),
    messages: [
      {
        role: 'user',
        content: buildUserPrompt({ title, brief, claims, hasTopics, inspirationPiece, brandGuideContent }),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error('Claude response contained no text block');
  }

  const parsed = parseCaptions(textBlock.text);
  const missing = PLATFORMS.filter((p) => !parsed[p]);
  if (missing.length > 0) {
    throw new Error(
      `Claude's response was missing captions for: ${missing.join(', ')}. Raw response:\n${textBlock.text}`
    );
  }

  const claimKeysUsed = extractClaimsUsed(textBlock.text);
  const claimsUsed = claims.filter((c) => claimKeysUsed.includes(c.claim_key));
  const claimsFlaggedForReview = claimsUsed.filter((c) => c.status === 'NEEDS_HUMAN_REVIEW');

  const batchId = crypto.randomUUID();
  const rows = PLATFORMS.map((platform) => ({
    content_item_id: null,
    platform,
    caption_text: parsed[platform],
    status: 'pending',
    batch_id: batchId,
    topic_label: title.trim(),
  }));

  const inserted = await insert('social_captions', rows);
  return { captions: inserted, batchId, claimsFlaggedForReview };
}

module.exports = { generateStandaloneCaptions, PLATFORMS };
