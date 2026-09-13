/**
 * lib/anthropic.js
 * Thin wrapper around the Anthropic SDK client, with a clear error if the
 * API key hasn't been supplied yet.
 */

const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (client) return client;

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'Missing ANTHROPIC_API_KEY. Add it to your .env file before running the ' +
        'content engine — see .env.example. Peter needs to supply this key ' +
        '(from console.anthropic.com) before any drafting can happen.'
    );
  }

  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

module.exports = { getClient };
