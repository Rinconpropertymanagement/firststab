'use strict';

/**
 * lib/folder-parser.js
 * Parses a single Backblaze B2 folder NAME/PATH into structured fields
 * (address, unit, inspection type, date) plus a confidence score, using
 * Claude. Used by the periodic indexing job
 * (POST /api/security-deposit/internal/index-b2-photos in router.js).
 *
 * HARD REQUIREMENT — not optional (Asimov, SPEC.md Neo section #5):
 * this function sends Claude ONLY the folder path/name string. Never
 * photo bytes, never the photo files themselves. "AI reads a filename"
 * and "AI reads a photo of someone's apartment" are materially different
 * privacy exposures, and this tool only ever needs the first one. Do not
 * extend this to fetch or send image data — even as an accuracy
 * improvement — without a separate privacy review first.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-5';

const PROMPT_PREFIX = `You are looking at the NAME of a folder in a property management company's photo archive. The folder was typed by hand by a property inspector, so it is often inconsistent, abbreviated, or slightly misspelled. Based ONLY on the folder name text below (you have not seen any photos or files inside it — none exist in this conversation), extract:

- address: the property street address this folder is most likely for (string or null — just the street-level text as written, do not guess a city/state that isn't present)
- unit: the unit number/letter, if the folder name mentions one (string or null)
- inspection_type: one of "move_in", "move_out", or "other" — based on words like "move in", "movein", "mi", "move out", "moveout", "mo", "vacate", "turnover", "inspection". If genuinely unclear, use "other".
- date: any date the folder name contains, in YYYY-MM-DD format (string or null — if only a partial date like a month/year is present, use the first of that month; if no date at all, null)
- confidence: your confidence that address/unit/inspection_type/date were all read correctly from this folder name, from 0.0 (pure guess) to 1.0 (unambiguous). Use a LOW confidence when the folder name is vague, uses initials only, has no clear address, or has ambiguous abbreviations — this number decides whether a human reviews the match, so err toward a lower number when in doubt.

Return ONLY a JSON object, no explanation, no markdown fences:
{"address": null, "unit": null, "inspection_type": "other", "date": null, "confidence": 0.0}

Folder name/path:
`;

async function parseFolderName(folderPath) {
  if (!folderPath || typeof folderPath !== 'string') {
    throw new Error('parseFolderName requires a non-empty folder path string.');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      // Folder name/path text ONLY — never image data. See file header.
      { role: 'user', content: PROMPT_PREFIX + folderPath },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response.');
  const raw = textBlock.text.trim();
  const jsonStart = raw.search(/[{[]/);
  const trimmed = jsonStart > 0 ? raw.slice(jsonStart) : raw;
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // A parse failure is not a crash — return the lowest possible
    // confidence so this folder always lands in the manual-review queue
    // instead of silently being skipped or (worse) auto-indexed on
    // garbage data.
    return {
      parsed_address: null,
      parsed_unit: null,
      parsed_inspection_type: null,
      parsed_date: null,
      confidence_score: 0,
      model_version: MODEL,
    };
  }

  const validTypes = ['move_in', 'move_out', 'other'];
  return {
    parsed_address: parsed.address || null,
    parsed_unit: parsed.unit || null,
    parsed_inspection_type: validTypes.includes(parsed.inspection_type) ? parsed.inspection_type : null,
    parsed_date: parsed.date || null,
    confidence_score: typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0,
    model_version: MODEL,
  };
}

module.exports = { parseFolderName };
