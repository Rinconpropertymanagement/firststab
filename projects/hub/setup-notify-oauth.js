#!/usr/bin/env node
/**
 * setup-notify-oauth.js
 * One-time setup: authorizes Gmail send ONLY, for the Hub's own
 * notification-sending address (noreply@rinconmanagement.com).
 *
 * This is a sibling of projects/calendar-assistant/setup-oauth.js, not a
 * replacement for it — that script authorizes Peter's own personal Google
 * account (peter@rinconmanagement.com) for morning-briefing email AND
 * calendar read/write. This script is deliberately narrower: it requests
 * gmail.send only — the noreply@ account has no reason to ever touch a
 * calendar.
 *
 * Reuses the SAME Google Cloud OAuth application (GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET, the "Rincon Assistant" app) that calendar-assistant
 * and appfolio-sync already use — no new Google Cloud app needed. What's
 * new is the refresh token this produces: a refresh token is tied to
 * whichever Google account you sign into below, so running this while
 * signed in as noreply@rinconmanagement.com produces a token scoped to
 * THAT account — separate from the existing GOOGLE_REFRESH_TOKEN, which
 * stays tied to Peter's own account, unchanged, still used by
 * calendar-assistant and appfolio-sync.
 *
 * Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from the repo's ROOT
 * .env (two levels up from this file) — the same place appfolio-sync
 * reads them from — not a hub-local .env.
 *
 * Uses port 3033 for its local callback — the same port as
 * calendar-assistant's setup-oauth.js. Both are one-time, manually-run
 * setup scripts; the two of them ever needing to run at the exact same
 * moment isn't realistic, so sharing the port (already registered as an
 * authorized redirect URI on the "Rincon Assistant" OAuth app) is simpler
 * than registering a second one in Google Cloud Console.
 *
 * Run this once, copy the printed line into the repo's ROOT .env.
 *
 * Usage:
 *   node setup-notify-oauth.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { google } = require('googleapis');
const http = require('http');
const { URL } = require('url');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT          = 3033;
const REDIRECT_URI  = `http://localhost:${PORT}/oauth2callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in the repo\'s root .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send', // send Hub notification emails — nothing else
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // forces Google to issue a fresh refresh token
});

console.log('');
console.log('======================================================');
console.log('  RINCON HUB — Notification Sender Authorization');
console.log('======================================================');
console.log('');
console.log('This grants the Hub permission to:');
console.log('  • Send email notifications — nothing else (no calendar access requested)');
console.log('');
console.log('Step 1: Open this URL in your browser:');
console.log('');
console.log(authUrl);
console.log('');
console.log('Step 2: Sign in as noreply@rinconmanagement.com');
console.log('        — NOT your own personal Google account — and click Allow.');
console.log('');
console.log('Waiting...');
console.log('');

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://localhost:${PORT}`);
    if (parsed.pathname !== '/oauth2callback') {
      res.writeHead(404); res.end('Not found'); return;
    }

    const code = parsed.searchParams.get('code');
    if (!code) {
      res.writeHead(400); res.end('No authorization code. Please try again.'); return;
    }

    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:600px">
        <h2 style="color:#534AB7">Authorization successful!</h2>
        <p>You can close this tab and return to your terminal.</p>
      </body></html>
    `);
    server.close();

    if (!tokens.refresh_token) {
      console.error('ERROR: Google did not return a refresh token.');
      console.error('Fix: While signed in as noreply@rinconmanagement.com, go to');
      console.error('     https://myaccount.google.com/permissions');
      console.error('     Remove the Rincon app, then run this script again.');
      process.exit(1);
    }

    console.log('======================================================');
    console.log('  SUCCESS');
    console.log('======================================================');
    console.log('');
    console.log('Copy this line into the repo\'s ROOT .env file');
    console.log('(this is a NEW line — it does NOT replace GOOGLE_REFRESH_TOKEN,');
    console.log('which stays exactly as-is for calendar-assistant/appfolio-sync):');
    console.log('');
    console.log(`HUB_NOTIFY_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('');

  } catch (err) {
    res.writeHead(500); res.end('Authorization failed. Check your terminal.');
    server.close();
    console.error('ERROR:', err.message);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use. Close whatever is using it and retry.`);
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
