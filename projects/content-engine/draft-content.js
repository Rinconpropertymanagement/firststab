#!/usr/bin/env node
/**
 * draft-content.js
 * CLI to trigger the content drafting engine: topic in, grounded draft out.
 * Writes the result to Supabase (content_items, status='draft'). Does not
 * publish anywhere — a human reviews and copies the draft out manually.
 *
 * Usage:
 *   node draft-content.js --title "..." --brief "..." --type blog_post --topics security-deposits,ab-1482
 *   node draft-content.js --help
 */

// Look for .env next to this file first (matches how it's deployed on the
// server, e.g. /var/www/content-engine/.env), and fall back to the shared
// project-root .env two levels up (matches local dev's nested repo layout,
// e.g. projects/content-engine/draft-content.js -> ../../.env). Whichever
// exists first wins — this makes the same file work correctly in both places.
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });
}

const { draftContent, VALID_CONTENT_TYPES } = require('./lib/draft');

function printHelp() {
  console.log(`
draft-content.js — draft a piece of content grounded in Rincon's legal
compliance knowledge base (Ventura County + CA state law).

Required flags:
  --title "<string>"     Working title for the piece
  --brief "<string>"      The angle/summary — what the piece should cover
  --type <content_type>   One of: ${VALID_CONTENT_TYPES.join(', ')}

Optional flags:
  --topics <a,b,c>        Comma-separated keywords to match against the
                          compliance knowledge base topics (e.g.
                          "security-deposits,ab-1482"). Run with
                          --list-topics to see all available topic keys.
                          Leave this out entirely for general content that
                          isn't legal in nature (e.g. maintenance tips,
                          vendor advice, seasonal reminders) — the draft
                          will be written from --title and --brief alone,
                          with no legal citations attached.
  --author "<string>"    Author name to attribute the draft to
  --source-suggestion <uuid>
                          topic_suggestions.id this draft came from, if any
  --list-topics           Print all available compliance topic keys and exit
  --help                  Show this help and exit

Example (legal topic, grounded in the compliance knowledge base):
  node draft-content.js \\
    --title "What Ventura County Landlords Need to Know About Security Deposits in 2026" \\
    --brief "Explain the current security deposit cap and return timeline rules, aimed at first-time landlords." \\
    --type blog_post \\
    --topics security-deposits

Example (general content, no legal topic):
  node draft-content.js \\
    --title "5 Fall Maintenance Tips to Prevent Winter Plumbing Problems" \\
    --brief "Practical, seasonal maintenance advice for landlords, aimed at reducing emergency calls." \\
    --type blog_post

What this does NOT do:
  - Does not publish to any website, social platform, or email service
  - Does not send anything to a tenant or owner
  - A human must review the draft in Supabase (or the future review page)
    before it goes anywhere
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--list-topics') {
      args.listTopics = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (args['list-topics']) {
    args.listTopics = true;
  }

  if (args.listTopics) {
    const { listTopics } = require('./lib/compliance');
    const topics = await listTopics();
    console.log('Available compliance topics:');
    topics.forEach((t) => console.log(`  - ${t.topic_key}`));
    return;
  }

  const missing = [];
  if (!args.title) missing.push('--title');
  if (!args.brief) missing.push('--brief');
  if (!args.type) missing.push('--type');

  if (missing.length > 0) {
    console.error(`[ERROR] Missing required flag(s): ${missing.join(', ')}\n`);
    printHelp();
    process.exit(1);
  }

  const topicKeywords = args.topics
    ? args.topics.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  console.log(`Drafting "${args.title}" (${args.type})...`);
  if (topicKeywords.length > 0) {
    console.log(`Grounding topic keywords: ${topicKeywords.join(', ')}`);
  } else {
    console.log('No topics selected — drafting general content from the brief alone (no legal grounding).');
  }

  try {
    const { contentItem, claimsUsed, claimsFlaggedForReview } = await draftContent({
      title: args.title,
      brief: args.brief,
      contentType: args.type,
      topicKeywords,
      sourceTopicSuggestionId: args['source-suggestion'] || null,
      authorName: args.author || null,
    });

    console.log(`\n✓ Draft saved to content_items (id: ${contentItem.id}, status: draft)`);
    console.log(`  Claims cited: ${claimsUsed.length}`);
    if (claimsFlaggedForReview.length > 0) {
      console.log(
        `  ⚠ ${claimsFlaggedForReview.length} cited claim(s) are flagged NEEDS_HUMAN_REVIEW:`
      );
      claimsFlaggedForReview.forEach((c) => console.log(`    - ${c.claim_key}: ${c.notes || c.statement}`));
    }
    console.log('\n--- DRAFT BODY ---\n');
    console.log(contentItem.body);
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  }
}

main();
