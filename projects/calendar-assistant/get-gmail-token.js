#!/usr/bin/env node
/**
 * get-gmail-token.js
 * One-time setup: authorizes Gmail and prints your refresh token.
 *
 * Run this ONCE on your local machine:
 *   node get-gmail-token.js
 *
 * Then copy the printed refresh token into .env as GOOGLE_REFRESH_TOKEN=...
 *
 * Requires: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (or environment)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3033/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// We only need permission to send email on Peter's behalf
const SCOPES = ['https://www.googleapis.com/auth/gmail.send'];

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // forces Google to return a refresh token every time
});

console.log('');
console.log('======================================================');
console.log('  GMAIL AUTHORIZATION — one-time setup');
console.log('======================================================');
console.log('');
console.log('Step 1: Open this URL in your browser:');
console.log('');
console.log(authUrl);
console.log('');
console.log('Step 2: Sign in with peter@rinconmanagement.com');
console.log('        and click "Allow".');
console.log('');
console.log('Step 3: This script will automatically capture the code');
console.log('        and print your refresh token below.');
console.log('');
console.log('Waiting for authorization...');
console.log('');

// Spin up a temporary local web server to catch the OAuth callback
const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = url.parse(req.url, true);
    if (parsedUrl.pathname !== '/oauth2callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = parsedUrl.query.code;
    if (!code) {
      res.writeHead(400);
      res.end('No authorization code received. Please try again.');
      return;
    }

    // Exchange the code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    // Send a success page to the browser
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html><body style="font-family:sans-serif;padding:40px;max-width:600px">
        <h2 style="color:#534AB7">Authorization successful!</h2>
        <p>You can close this tab and go back to your terminal.</p>
      </body></html>
    `);

    server.close();

    if (!tokens.refresh_token) {
      console.error('ERROR: Google did not return a refresh token.');
      console.error('This usually means you already authorized this app.');
      console.error('');
      console.error('Fix: Go to https://myaccount.google.com/permissions');
      console.error('     Remove "Rincon Morning Email" (or your app name),');
      console.error('     then run this script again.');
      process.exit(1);
    }

    console.log('======================================================');
    console.log('  SUCCESS — copy this line into your .env file:');
    console.log('======================================================');
    console.log('');
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('');
    console.log('Then copy the same value to /var/www/calendar-assistant/.env on Sally.');
    console.log('');

  } catch (err) {
    res.writeHead(500);
    res.end('Authorization failed. Check your terminal for details.');
    server.close();
    console.error('ERROR during token exchange:', err.message);
    process.exit(1);
  }
});

server.listen(3033, '127.0.0.1', () => {
  // Server is ready — user just needs to open the URL above
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('ERROR: Port 3033 is already in use.');
    console.error('Close whatever is using that port and try again.');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
