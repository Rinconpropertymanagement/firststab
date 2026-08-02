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

const PROMPT = `You are extracting structured data from an insurance declaration page for a property management company. The document may cover ONE property or MULTIPLE properties (locations).

Return ONLY a valid JSON array — one object per covered property/location. If the document covers a single property, return an array with one object. If it covers multiple properties, return one object per property.

Each object must have exactly these fields. If a field is not visible or cannot be determined with confidence, return null for that field. Do not guess or infer values you cannot read directly from the document.

[
  {
    "policy_number": "<string or null — the policy or certificate number, same across all locations on the same document>",
    "insurer_name": "<string or null — the name of the insurance company issuing the policy, NOT the agent or broker>",
    "effective_date": "<YYYY-MM-DD or null>",
    "expiration_date": "<YYYY-MM-DD or null>",
    "coverage_amount": <PREMISES LIABILITY amount as a number with no currency symbol — this is the LIABILITY protection section, NOT the dwelling or structure value. Look for labels like "Personal Liability", "Premises Liability", "Coverage E", "Liability Coverage", or "Each Occurrence" in the liability section. Typical values are 300000, 500000, or 1000000. Return null if you cannot find a liability coverage amount.>,
    "named_insured": "<string or null — the name of the insured person or entity>",
    "property_address": "<the street address of the INSURED PROPERTY — the physical location being covered. NOT the insurance company's address. NOT the agent's or broker's address. NOT a mailing address or billing address. Look for labels like 'Property Address', 'Location', 'Premises Address', 'Risk Location', 'Described Location', 'Location of Premises', or 'Schedule of Locations'. These are typically residential or commercial street addresses in Southern California. If multiple properties appear, each gets its own object. Return null only if you truly cannot find any insured property address.>"
  }
]

Return the JSON array and nothing else. No explanation, no markdown, no code block.`;

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

  // Strip markdown code fences if Claude wraps the JSON despite being told not to
  const cleaned = responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    // Normalise to array — handle both legacy single-object and new array format
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(obj => ({ ...EMPTY_FIELDS, ...obj }));
  } catch {
    console.error(`[extract-policy] JSON parse failed. Raw response: ${responseText}`);
    return [{ extraction_error: true, raw: responseText, ...EMPTY_FIELDS }];
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
