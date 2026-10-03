#!/usr/bin/env node
/**
 * generate-captions.js
 * CLI to generate Facebook/LinkedIn/Instagram captions for an approved
 * blog post. Writes to social_captions with status='pending'. Does not
 * post anywhere — a human copies each caption out manually.
 *
 * Usage:
 *   node generate-captions.js --content-item <uuid>
 *   node generate-captions.js --help
 */

// Look for .env next to this file first (matches how it's deployed on the
// server, e.g. /var/www/content-engine/.env), and fall back to the shared
// project-root .env two levels up (matches local dev's nested repo layout,
// e.g. projects/content-engine/generate-captions.js -> ../../.env). Whichever
// exists first wins — this makes the same file work correctly in both places.
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });
}

const { generateCaptions } = require('./lib/captions');

function printHelp() {
  console.log(`
generate-captions.js — generate social captions for an approved blog post.

Required flags:
  --content-item <uuid>   id of a content_items row with status='approved'
                          and content_type='blog_post'

Optional flags:
  --help                  Show this help and exit

What this does NOT do:
  - Does not post to Facebook, LinkedIn, or Instagram
  - Does not require any social media credentials
  - A human copies each caption out of social_captions manually
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      args[key] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args['content-item']) {
    printHelp();
    if (!args.help) process.exit(1);
    return;
  }

  console.log(`Generating captions for content_item ${args['content-item']}...`);

  try {
    const captions = await generateCaptions(args['content-item']);
    console.log(`\n✓ ${captions.length} caption(s) saved to social_captions (status: pending)\n`);
    captions.forEach((c) => {
      console.log(`--- ${c.platform.toUpperCase()} ---`);
      console.log(c.caption_text);
      console.log('');
    });
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  }
}

main();
