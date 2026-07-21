#!/usr/bin/env node
/**
 * extract-policy.js
 * Reads a PDF or image file and uses Claude AI to extract insurance policy fields.
 *
 * Usage (CLI):
 *   node extract-policy.js /path/to/declaration-page.pdf
 *   node extract-policy.js /path/to/dec-page.jpg
 *   node extract-policy.js --help
 *
 * Usage (module):
 *   const { extractPolicy } = require('./extract-policy');
 *   const fields = await extractPolicy('/path/to/file.pdf');
 *
 * Required environment variable:
 *   ANTHROPIC_API_KEY
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs   = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

if (process.argv.includes('--help')) {
  console.log(`
extract-policy.js — Extract insurance fields from a declaration page

Reads a PDF or image file and returns structured JSON with policy details
extracted by Claude AI.

Usage:
  node extract-policy.js /path/to/declaration-page.pdf
  node extract-policy.js /path/to/dec-page.jpg

Supported file types: .pdf, .jpg, .jpeg, .png

Output (JSON to stdout):
  {
    "policy_number":    "string or null",
    "insurer_name":     "string or null",
    "effective_date":   "YYYY-MM-DD or null",
    "expiration_date":  "YYYY-MM-DD or null",
    "coverage_amount":  number or null,
    "named_insured":    "string or null",
    "property_address": "string or null"
  }

Environment variable required:
  ANTHROPIC_API_KEY
`);
  process.exit(0);
}

const PROMPT = `You are extracting structured data from an insurance declaration page. Return ONLY a valid JSON object with these exact fields. If a field is not visible or cannot be determined with confidence, return null for that field. Do not guess or infer values you cannot read directly from the document.

{
  "policy_number": "<string or null>",
  "insurer_name": "<string or null>",
  "effective_date": "<YYYY-MM-DD or null>",
  "expiration_date": "<YYYY-MM-DD or null>",
  "coverage_amount": <number with no currency symbol, e.g. 1000000, or null>,
  "named_insured": "<string or null>",
  "property_address": "<string or null>"
}

Return the JSON object and nothing else. No explanation, no markdown, no code block.`;

const MIME_TYPES = {
  '.pdf':  'application/pdf',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
};

const EMPTY_FIELDS = {
  policy_number:    null,
  insurer_name:     null,
  effective_date:   null,
  expiration_date:  null,
  coverage_amount:  null,
  named_insured:    null,
  property_address: null,
};

async function extractPolicy(filePath) {
  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];

  if (!mimeType) {
    throw new Error(`Unsupported file type: ${ext}. Accepted: .pdf, .jpg, .jpeg, .png`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const base64     = fileBuffer.toString('base64');

  // Build the content block — PDFs use 'document', images use 'image'
  const contentBlock = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mimeType, data: base64 } };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [
      {
        role:    'user',
        content: [contentBlock, { type: 'text', text: PROMPT }],
      },
    ],
  });

  const responseText = response.content[0].text.trim();

  try {
    return JSON.parse(responseText);
  } catch {
    console.error(`[extract-policy] JSON parse failed. Raw response: ${responseText}`);
    return { extraction_error: true, raw: responseText, ...EMPTY_FIELDS };
  }
}

// ─── CLI mode ─────────────────────────────────────────────────────────────────
async function run() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node extract-policy.js <file-path>');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[ERROR] ANTHROPIC_API_KEY is not set.');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`[ERROR] File not found: ${filePath}`);
    process.exit(1);
  }

  console.error(`[${new Date().toISOString()}] Extracting fields from: ${filePath}`);
  const result = await extractPolicy(filePath);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  run().catch(err => {
    console.error('[ERROR]', err.message);
    process.exit(1);
  });
}

module.exports = { extractPolicy };
