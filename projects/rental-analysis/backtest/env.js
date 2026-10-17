/**
 * backtest/env.js
 * Loads the two .env files the accuracy test needs, WITHOUT printing or
 * returning any value: the repo-root .env (Supabase service-role key) and
 * projects/rental-analysis/.env (Recore token). First file loaded wins for a
 * name that appears in both. Call before requiring anything from ../lib that
 * reads process.env at require time (lib/supabase.js does).
 */
const path = require('path');
const dotenv = require('dotenv');

function loadEnv() {
  dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env'), quiet: true });
  dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });
}

function requireEnv(names) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')} (names only; values are never printed).`);
}

const SECRET_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'RECORE_SERVER_TOKEN', 'RECORE_BROWSER_TOKEN', 'RECORE_CLIENT_SECRET', 'RENTCAST_API_KEY', 'ANTHROPIC_API_KEY'];

// Any error text that might echo a URL, a header or a key gets the secret
// stripped before it is shown: by pattern, and by the actual values in the
// environment.
function redact(text) {
  let out = String(text)
    .replace(/access_token=[^&\s"']+/g, 'access_token=REDACTED')
    .replace(/(apikey|authorization)(["']?\s*[:=]\s*["']?)(bearer\s+)?[A-Za-z0-9._-]{12,}/gi, '$1$2REDACTED');
  for (const name of SECRET_NAMES) {
    const value = process.env[name];
    if (value && value.length >= 8) out = out.split(value).join('REDACTED');
  }
  return out;
}

module.exports = { loadEnv, requireEnv, redact };
