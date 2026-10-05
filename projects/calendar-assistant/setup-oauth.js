#!/usr/bin/env node
/**
 * setup-oauth.js
 * One-time setup: authorizes Gmail send + Google Calendar read/write.
 * Run this once on your local machine, copy the token into .env.
 *
 * Usage:
 *   node setup-oauth.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { google } = require('googleapis');
const http = require('http');
const { URL } = require('url');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3033/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',           // send morning email
  'https://www.googleapis.com/auth/calendar.readonly',    // list calendars + read events
  'https://www.googleapis.com/auth/calendar.events',      // create / update events
];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // forces Google to issue a fresh refresh token
});

console.log('');
console.log('======================================================');
console.log('  RINCON ASSISTANT — Google Authorization');
console.log('======================================================');
console.log('');
console.log('This grants the assistant permission to:');
console.log('  • Send your morning briefing email');
console.log('  • Read your Google Calendar events');
console.log('  • Add and update events on your calendar');
console.log('');
console.log('Step 1: Open this URL in your browser:');
console.log('');
console.log(authUrl);
console.log('');
console.log('Step 2: Sign in with peter@rinconmanagement.com');
console.log('        and click Allow.');
console.log('');
console.log('Waiting...');
console.log('');

const server = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, 'http://localhost:3033');
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
      console.error('Fix: Go to https://myaccount.google.com/permissions');
      console.error('     Remove the Rincon app, then run this script again.');
      process.exit(1);
    }

    console.log('======================================================');
    console.log('  SUCCESS');
    console.log('======================================================');
    console.log('');
    console.log('Copy this line into your .env file');
    console.log('(replace the existing GOOGLE_REFRESH_TOKEN line):');
    console.log('');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('');
    console.log('Then update Sally:');
    console.log('  ssh root@2.25.70.7');
    console.log(`  echo 'GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}' >> /var/www/calendar-assistant/.env`);
    console.log('  (or edit the file directly to replace the existing line)');
    console.log('');

  } catch (err) {
    res.writeHead(500); res.end('Authorization failed. Check your terminal.');
    server.close();
    console.error('ERROR:', err.message);
    process.exit(1);
  }
});

server.listen(3033, '127.0.0.1', () => {});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('ERROR: Port 3033 is already in use. Close whatever is using it and retry.');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
