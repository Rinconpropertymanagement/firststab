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

const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { PDFParse } = require('pdf-parse');

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

const PROMPT = `You are reading an insurance document for a Southern California property management company. Extract the fields below and return them as a JSON array — one object per insured property location. A single document may cover multiple properties; if so, return one object per property.

STEP 1 — Find every insured property address:
Scan the entire document for any of these labels: "Prop. Loc", "Prop. Loc.", "Prop Loc", "Property Location", "Property Address", "Premises Address", "Described Premises", "Risk Location", "Location of Premises", "Schedule of Locations", "Insured Location", or "Location". Extract the address that follows each label. These addresses will be in California (CA). Addresses may use dashes as separators instead of commas (e.g. "263 S VENTURA RD UNIT 270-PORT HUENEME-CA 93041"). Do NOT use the insurance company's address, agent's address, or any address in the letterhead/return-address area at the top of the document — those will be out-of-state addresses. If multiple California property addresses appear, return one array object per address.

STEP 2 — For each property address found, extract:
- policy_number: the policy or certificate number (string or null)
- insurer_name: the name of the insurance COMPANY (not agent/broker) (string or null)
- effective_date: policy start date in YYYY-MM-DD format (or null)
- expiration_date: policy end date in YYYY-MM-DD format (or null)
- coverage_amount: the PREMISES LIABILITY dollar amount as a plain number — look for "Premises Liability", "Personal Liability", "Coverage E", "Each Occurrence", or "Liability Coverage". Do NOT use dwelling, structure, or property damage amounts. Typical values: 300000, 500000, 1000000. (number or null)
- named_insured: name of the insured person or entity (string or null)
- property_address: the California property address from Step 1 (string or null)

Return ONLY the JSON array. No explanation, no markdown fences, no code blocks.

[
  {
    "policy_number": null,
    "insurer_name": null,
    "effective_date": null,
    "expiration_date": null,
    "coverage_amount": null,
    "named_insured": null,
    "property_address": null
  }
]`;

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

// Extract "Prop. Loc:" style addresses directly from PDF text — faster and
// more reliable than asking Claude to find them in a cluttered document.
async function extractPropLocAddresses(filePath) {
  let parser;
  try {
    const buf    = fs.readFileSync(filePath);
    // pdf-parse v2's API: require('pdf-parse') no longer returns a callable
    // function (that was v1) — it returns a { PDFParse } class you construct.
    parser       = new PDFParse({ data: buf });
    const result = await parser.getText();
    const text   = result.text;

    // Match "Prop. Loc:", "Prop Loc:", "Property Location:", etc. followed by the address
    const pattern = /Prop(?:erty)?\s*\.?\s*Loc(?:ation)?\.?\s*:?\s*([^\n\r]{5,80})/gi;
    const found   = [];
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const addr = m[1].trim().replace(/\s+/g, ' ');
      if (addr) found.push(addr);
    }
    return { addresses: found, fullText: text };
  } catch (err) {
    // Non-fatal: Claude still reads the PDF directly in extractPolicy() below,
    // this is only a pre-scan accuracy assist. But log it — silently returning
    // empty here previously hid a real bug for months.
    console.error(`[extract-policy] Prop. Loc pre-scan failed: ${err.message}`);
    return { addresses: [], fullText: '' };
  } finally {
    if (parser) await parser.destroy();
  }
}

async function extractPolicy(filePath) {
  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext];

  if (!mimeType) {
    throw new Error(`Unsupported file type: ${ext}. Accepted: .pdf, .jpg, .jpeg, .png`);
  }

  const fileBuffer = fs.readFileSync(filePath);
  const base64     = fileBuffer.toString('base64');

  // For PDFs, pre-extract "Prop. Loc:" addresses from raw text so Claude
  // gets them handed to it directly — avoids misreading cluttered letterheads.
  let propLocHint = '';
  if (mimeType === 'application/pdf') {
    const { addresses } = await extractPropLocAddresses(filePath);
    if (addresses.length > 0) {
      propLocHint = `\n\nIMPORTANT: The following property addresses were found in this document next to "Prop. Loc" labels. Use these as the property_address values (one object per address):\n${addresses.map((a, i) => `${i + 1}. ${a}`).join('\n')}`;
      console.error(`[extract-policy] Pre-extracted Prop. Loc addresses: ${addresses.join(' | ')}`);
    }
  }

  // Build the content block — PDFs use 'document', images use 'image'
  const contentBlock = mimeType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: mimeType, data: base64 } };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model:      'claude-sonnet-5',
    max_tokens: 4096,
    messages: [
      {
        role:    'user',
        content: [contentBlock, { type: 'text', text: PROMPT + propLocHint }],
      },
    ],
  });

  // sonnet-5 may return thinking blocks before the text block — find the text block explicitly
  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text block in Claude response');
  const responseText = textBlock.text.trim();

  // Strip any reasoning text before the JSON array/object, then strip markdown fences
  const jsonStart = responseText.search(/[\[{]/);
  const trimmed   = jsonStart > 0 ? responseText.slice(jsonStart) : responseText;
  const cleaned   = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    // Normalise to array — handle both legacy single-object and new array format
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const result = arr.map(obj => ({ ...EMPTY_FIELDS, ...obj }));
    console.error(`[extract-policy] Extracted ${result.length} propert(ies): ${result.map(r => r.property_address).join(' | ')}`);
    return result;
  } catch {
    console.error(`[extract-policy] JSON parse failed. Raw response:\n${responseText}`);
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
