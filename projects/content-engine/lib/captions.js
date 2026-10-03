/**
 * lib/captions.js
 * Generates Facebook/LinkedIn/Instagram captions for an approved blog post.
 * Simple text only — no image generation, no posting. Inserts into
 * social_captions with status='pending' for a human to review and approve.
 */

const { getClient } = require('./anthropic');
const { select, insert } = require('./supabase');
const { getActiveBrandGuide, formatBrandGuideForPrompt, brandGuideSystemRule } = require('./brand-guide');

const MODEL = 'claude-opus-4-8';
const PLATFORMS = ['facebook', 'linkedin', 'instagram'];

function buildSystemPrompt({ hasBrandGuide = false } = {}) {
  // Shared with draft.js/revise.js (lib/brand-guide.js) so the "style only,
  // never facts" wording never drifts between prompts.
  const brandGuideRule = hasBrandGuide ? brandGuideSystemRule() : '';

  return `You write social media captions for Rincon Management, a property
management company in Ventura County, California, promoting a blog post
they've already published. You are given the full blog post text.

Rules:
- Do not invent facts, statistics, or legal claims beyond what's in the
  blog post text you're given.
- Do not include hashtags that reference a real tenant, owner, or address.
- Do not include a "post this now" or auto-publish instruction — a human
  copies the caption out manually.
- Match tone to platform: LinkedIn is professional/informative, Facebook is
  warm and community-oriented, Instagram is short and visual-first (assume
  a graphic will accompany it).${brandGuideRule}`;
}

function buildUserPrompt({ title, body, brandGuideContent }) {
  const brandGuideSection = brandGuideContent ? formatBrandGuideForPrompt(brandGuideContent) : '';

  return `Here is a blog post that Rincon Management has approved and published.
Write one caption for each of Facebook, LinkedIn, and Instagram promoting it.

TITLE: ${title}

BODY:
${body}

${brandGuideSection}Respond in exactly this format, with nothing else before or after:

FACEBOOK:
<caption text>

LINKEDIN:
<caption text>

INSTAGRAM:
<caption text>`;
}

function parseCaptions(text) {
  const result = {};
  for (const platform of PLATFORMS) {
    const label = platform.toUpperCase();
    const regex = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`, 'i');
    const match = text.match(regex);
    if (match) {
      result[platform] = match[1].trim();
    }
  }
  return result;
}

/**
 * Generate social captions for an approved blog post content_item.
 * @param {string} contentItemId - id of a content_items row with status='approved'
 */
async function generateCaptions(contentItemId) {
  const [contentItem] = await select(
    'content_items',
    `select=*&id=eq.${contentItemId}`
  );

  if (!contentItem) {
    throw new Error(`No content_item found with id ${contentItemId}`);
  }
  if (contentItem.content_type !== 'blog_post') {
    throw new Error(
      `Social captions are only generated for blog_post content (got "${contentItem.content_type}")`
    );
  }
  if (contentItem.status !== 'approved') {
    throw new Error(
      `content_item ${contentItemId} has status "${contentItem.status}", not "approved". ` +
        `Only approved blog posts get captions generated.`
    );
  }

  // Persistent voice/style guidance saved in the database — independent of
  // this specific blog post. Returns null if Peter hasn't uploaded one yet,
  // in which case caption generation is unaffected (unchanged behavior).
  const brandGuide = await getActiveBrandGuide();
  const brandGuideContent = brandGuide ? brandGuide.content : null;

  const client = getClient();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: buildSystemPrompt({ hasBrandGuide: Boolean(brandGuideContent) }),
    messages: [
      {
        role: 'user',
        content: buildUserPrompt({ title: contentItem.title, body: contentItem.body, brandGuideContent }),
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

  const rows = PLATFORMS.map((platform) => ({
    content_item_id: contentItem.id,
    platform,
    caption_text: parsed[platform],
    status: 'pending',
  }));

  const inserted = await insert('social_captions', rows);
  return inserted;
}

module.exports = { generateCaptions, PLATFORMS };
