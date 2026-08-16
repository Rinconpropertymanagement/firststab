#!/usr/bin/env node
/**
 * server.js
 * Rincon Hub — the single shared login for Rincon Management's internal
 * tools. Real login (Supabase Auth), a home page listing the available
 * sections, and Insurance Compliance mounted in as the first section.
 *
 * WHAT THIS FILE DOES TODAY:
 *   - Serves a login page backed by real Supabase Auth (email + password) —
 *     the same identity backend projects/content-review already uses. Peter
 *     (and anyone else with a Supabase Auth account) logs in with the same
 *     email/password they already use for content-review. Nothing new to
 *     create.
 *   - Verifies the session on every request (lib/middleware.js) — not just
 *     "is there a cookie," but "is this still a valid Supabase session."
 *   - Serves a home page listing the hub's sections (Insurance Compliance
 *     today; more will be added the same way later).
 *   - Mounts Insurance Compliance (insurance/router.js) at /insurance and
 *     /api/insurance/* — migrated from projects/insurance-compliance. Its
 *     own separate Google sign-in page is gone; logging into the hub here
 *     is the only sign-in it needs now. See insurance/router.js's header
 *     comment for the full detail on what changed in that migration.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO YET (next steps, not bugs):
 *   - No hub-wide role/permission table lookup in lib/middleware.js itself
 *     — every logged-in Supabase Auth user can reach the hub's home page.
 *     Insurance Compliance layers its OWN permission check on top (see
 *     insurance/router.js), reading Neo's team_members /
 *     team_member_tool_roles tables. Whether the hub itself should also
 *     gate on team_members hub-wide is a separate decision, not made here.
 *
 * Usage:
 *   npm start        (from projects/hub/)
 *   node server.js
 *
 * Required environment variables (in .env):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SESSION_SECRET
 *
 * Optional:
 *   HUB_PORT   (default: 3500 — chosen to not collide with content-review's
 *               3300 or insurance-compliance's 3456, in case all three are
 *               running locally at once during development)
 */

// Look for .env next to this file first (matches how insurance-compliance
// and content-review are deployed on the server — a local .env sitting next
// to server.js), and fall back to the shared project-root .env two levels
// up (matches local dev's nested repo layout, e.g.
// projects/hub/server.js -> ../../.env). Whichever exists first wins — same
// dual-path approach as projects/content-review/server.js, so the hub works
// correctly in both places without extra setup.
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });
}

if (process.argv.includes('--help')) {
  console.log(`
server.js — Rincon Hub (shared login + sections)

GET  /login                 Login form
POST /login                  Submits email + password against Supabase Auth
GET  /logout                 Destroys the session, back to /login
GET  /forgot-password         Request-a-reset-email form
POST /forgot-password         Sends the reset email (always shows the same
                              "check your email" message either way)
GET  /reset-password          Set-a-new-password form (landing page for the
                              link in the reset email)
POST /reset-password          Submits the new password
GET  /                       Home page — hub sections (requires login)
GET  /healthz                 Plain JSON health check, no login required
GET  /insurance               Insurance Compliance dashboard (requires login
                              + a role in that tool — see insurance/router.js)
     /api/insurance/*         Insurance Compliance API routes
GET  /security-deposit        Security Deposit dashboard (requires login
                              + a role in that tool — see
                              security-deposit/router.js)
     /api/security-deposit/*  Security Deposit API routes
GET  /maintenance-history     Maintenance History dashboard (requires login
                              + a role in that tool — see
                              maintenance-history/router.js)
     /api/maintenance-history/*  Maintenance History API routes

Environment variables required (.env file):
  SUPABASE_URL
  SUPABASE_ANON_KEY
  SESSION_SECRET
  ANTHROPIC_API_KEY            (Insurance Compliance + Security Deposit —
                              Claude extraction / B2 folder-name parsing)
  SUPABASE_SERVICE_ROLE_KEY    (Insurance Compliance + Security Deposit —
                              reads/writes data)
  HUB_PORT                     (optional, default 3500)
  HUB_BASE_URL                 (optional — used to build the password-reset
                              link; defaults to http://localhost:<HUB_PORT>)

Optional (Insurance Compliance email notifications — degrades gracefully
if unset, see insurance/router.js):
  GMAIL_USER, GMAIL_APP_PASSWORD, DO_EMAIL, CRON_SECRET

Optional (Security Deposit — degrades gracefully if unset, see
security-deposit/router.js and .env.example):
  B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME  (read-only —
                              only needed by the B2 photo-indexing cron
                              route; the rest of the tool works without it)
  APPFOLIO_CLIENT_ID, APPFOLIO_CLIENT_SECRET  (only needed by the
                              connector's live-lookup methods)

Required (Maintenance History — the whole section exits at startup if
these two are missing, same as the other tools):
  LATCHEL_API_KEY              GET-only in this codebase's own code — see
                              maintenance-history/lib/latchel-connector.js
                              and .env.example for why this credential is a
                              weaker guarantee than the B2 read-only key.
  CRON_SECRET                   Shared secret for the two internal/cron
                              routes (internal/ingest, internal/
                              reconcile-properties) — same header/secret
                              already used by the other two tools' cron
                              routes.
`);
  process.exit(0);
}

const express = require('express');
const session = require('express-session');

const { signInWithPassword, requestPasswordReset, updatePasswordWithToken } = require('./lib/auth');
const { requireLogin } = require('./lib/middleware');
const { router: insuranceRouter, internalRouter: insuranceInternalRouter } = require('./insurance/router');
const { router: securityDepositRouter, internalRouter: securityDepositInternalRouter } = require('./security-deposit/router');
const { router: maintenanceHistoryRouter, internalRouter: maintenanceHistoryInternalRouter } = require('./maintenance-history/router');

// ─── Config ───────────────────────────────────────────────────────────────
const PORT = process.env.HUB_PORT || 3500;

const missing = [];
if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
if (!process.env.SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');

if (missing.length > 0) {
  console.error(`[ERROR] Missing environment variables: ${missing.join(', ')}`);
  console.error('[ERROR] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

// ─── App ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.urlencoded({ extended: true }));
// limit: '100mb' — Insurance Compliance's batch-save route sends multiple
// declaration-page files as base64 inside one JSON body. The default 100kb
// limit was fine for the hub's own login form but would reject those
// requests outright (413) once insurance-compliance is mounted below.
app.use(express.json({ limit: '100mb' }));

// ─── Session ──────────────────────────────────────────────────────────────
// name: 'hub.sid' — deliberately distinct from express-session's default
// cookie name ("connect.sid"), which content-review also uses. Cookies are
// not port-scoped on localhost, so if the hub (port 3500) and content-review
// (port 3300) both used the default name while running side by side in
// local dev, they'd clobber each other's cookie in the browser. Giving each
// app its own cookie name avoids that entirely.
app.use(
  session({
    name: 'hub.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // set true once the hub is served over HTTPS in production
      httpOnly: true,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      sameSite: 'lax',
    },
  })
);

// ─── Tiny HTML helpers (no templating library — plain string templates) ───
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page({ title, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — Rincon Hub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; }
    .wrap { max-width: 420px; margin: 10vh auto; padding: 2rem; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    h1 { font-size: 1.25rem; margin-top: 0; }
    label { display: block; font-size: 0.875rem; margin: 1rem 0 0.25rem; }
    input { width: 100%; padding: 0.5rem; box-sizing: border-box; border: 1px solid #d6d3d1; border-radius: 4px; font-size: 1rem; }
    button { margin-top: 1.5rem; width: 100%; padding: 0.6rem; background: #1c1917; color: #fff; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    .error { background: #fef2f2; color: #991b1b; padding: 0.6rem 0.8rem; border-radius: 4px; font-size: 0.875rem; margin-top: 1rem; }
    .notice { background: #f0fdf4; color: #166534; padding: 0.6rem 0.8rem; border-radius: 4px; font-size: 0.875rem; margin-top: 1rem; }
    .note { color: #78716c; font-size: 0.8125rem; margin-top: 2rem; }
    a { color: #44403c; }

    /* ── Home page nav — additive only, doesn't touch anything above ── */
    .top-row { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; }
    .top-row a { font-size: 0.8125rem; }
    .section-list { margin-top: 1.5rem; }
    .section-list-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #a8a29e; margin-bottom: 0.5rem; }
    .section-link { display: block; padding: 0.9rem 1rem; border: 1px solid #e7e5e4; border-radius: 6px; text-decoration: none; color: #1c1917; margin-bottom: 0.5rem; }
    .section-link:hover { background: #fafaf9; border-color: #d6d3d1; }
    .section-link strong { display: block; font-size: 0.9375rem; }
    .section-link span { display: block; font-size: 0.8125rem; color: #78716c; margin-top: 2px; font-weight: 400; }
  </style>
</head>
<body>
  <div class="wrap">${body}</div>
</body>
</html>`;
}

// ─── LOGIN / LOGOUT — no requireLogin on these ─────────────────────────────

app.get('/login', (req, res) => {
  if (req.session && req.session.accessToken) {
    return res.redirect('/');
  }
  const error = req.query.error ? escapeHtml(req.query.error) : null;
  const notice = req.query.notice ? escapeHtml(req.query.notice) : null;
  res.send(
    page({
      title: 'Log in',
      body: `
        <h1>Rincon Hub</h1>
        <form method="POST" action="/login">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autofocus>
          <label for="password">Password</label>
          <input type="password" id="password" name="password" required>
          <button type="submit">Log in</button>
        </form>
        ${error ? `<div class="error">${error}</div>` : ''}
        ${notice ? `<div class="notice">${notice}</div>` : ''}
        <div class="note"><a href="/forgot-password">Forgot password?</a></div>
        <div class="note">Use the same email and password you already use for the content review app.</div>
      `,
    })
  );
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.redirect('/login?error=' + encodeURIComponent('Enter your email and password.'));
  }
  try {
    const { user, session: supaSession } = await signInWithPassword(email, password);
    // Regenerate the session now, at the moment of successful login, instead
    // of reusing whatever session already existed on this browser (which may
    // have been created before login — or planted by someone else — "session
    // fixation"). regenerate() swaps req.session for a brand new object with
    // a fresh ID, so the login fields MUST be set inside its callback; setting
    // them beforehand would be discarded when the old session is replaced.
    req.session.regenerate((err) => {
      if (err) {
        console.error('[login] session regenerate failed:', err.message);
        return res.redirect('/login?error=' + encodeURIComponent('Something went wrong logging you in. Please try again.'));
      }
      req.session.accessToken = supaSession.access_token;
      req.session.refreshToken = supaSession.refresh_token;
      req.session.userEmail = user.email;
      res.redirect('/');
    });
  } catch (err) {
    res.redirect('/login?error=' + encodeURIComponent('That email or password is not right. Please try again.'));
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// ─── FORGOT PASSWORD — request the reset email ─────────────────────────────
// No requireLogin here on purpose: someone who forgot their password isn't
// logged in yet (that's the whole point).

app.get('/forgot-password', (req, res) => {
  res.send(
    page({
      title: 'Forgot password',
      body: `
        <h1>Reset your password</h1>
        <p class="note" style="margin-top:0.25rem">Enter your email and we'll send you a link to set a new password.</p>
        <form method="POST" action="/forgot-password">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required autofocus>
          <button type="submit">Send reset link</button>
        </form>
        <div class="note"><a href="/login">Back to log in</a></div>
      `,
    })
  );
});

app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  // Always show the same "check your email" message below, whether or not
  // this email belongs to a real account — see requestPasswordReset's
  // comment in lib/auth.js for why that matters.
  if (email) {
    try {
      await requestPasswordReset(email);
    } catch (err) {
      console.error('[forgot-password]', err.message);
    }
  }
  res.send(
    page({
      title: 'Check your email',
      body: `
        <h1>Check your email</h1>
        <p class="note" style="margin-top:0.25rem">
          If an account exists for that email address, we've sent a link to reset the password.
          The link expires after a while, so use it soon.
        </p>
        <div class="note"><a href="/login">Back to log in</a></div>
      `,
    })
  );
});

// ─── RESET PASSWORD — landing page for the link in the reset email ────────
// No requireLogin here either, same reason. This Supabase project uses the
// default (implicit) reset flow, not PKCE: the email link redirects here
// with the recovery token in the URL FRAGMENT (after "#"), e.g.
// #access_token=...&type=recovery. A URL fragment never reaches the server
// — only the browser can see it — so GET /reset-password serves a page with
// a small inline script that reads the fragment and POSTs the token + new
// password to this same route. Same pattern as content-review's
// /reset-password (server.js there), which this was copied from.

app.get('/reset-password', (req, res) => {
  const error = req.query.error ? escapeHtml(req.query.error) : null;
  res.send(
    page({
      title: 'Set your password',
      body: `
        <h1>Set your new password</h1>
        <div id="no-token-msg" class="error" style="display:none;">
          This reset link is missing or has expired. Go back to the email and click the link again, or request a new one.
        </div>
        ${error ? `<div class="error">${error}</div>` : ''}
        <form id="reset-form" method="POST" action="/reset-password">
          <input type="hidden" id="access_token" name="access_token" value="">
          <label for="password">New password</label>
          <input type="password" id="password" name="password" required minlength="6" autofocus>
          <label for="confirm_password">Confirm new password</label>
          <input type="password" id="confirm_password" name="confirm_password" required minlength="6">
          <button type="submit">Set password</button>
        </form>
        <script>
          (function () {
            // The recovery token arrives in the URL fragment (after "#"),
            // e.g. #access_token=xyz&type=recovery — the server never sees
            // this part of the URL, so we have to read it here in the browser.
            var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
            var accessToken = params.get('access_token');
            var form = document.getElementById('reset-form');

            if (!accessToken) {
              document.getElementById('no-token-msg').style.display = 'block';
              form.style.display = 'none';
              return;
            }
            document.getElementById('access_token').value = accessToken;

            form.addEventListener('submit', function (e) {
              var password = document.getElementById('password').value;
              var confirm = document.getElementById('confirm_password').value;
              if (password !== confirm) {
                e.preventDefault();
                alert('Passwords do not match.');
              }
            });
          })();
        </script>
      `,
    })
  );
});

app.post('/reset-password', async (req, res) => {
  const { access_token, password, confirm_password } = req.body;
  const backToForm = (msg) => res.redirect('/reset-password?error=' + encodeURIComponent(msg));

  if (!access_token) {
    return backToForm('This reset link is missing or has expired. Request a new one.');
  }
  if (!password || !confirm_password) {
    return backToForm('Enter and confirm your new password.');
  }
  if (password !== confirm_password) {
    return backToForm('Passwords do not match.');
  }
  if (password.length < 6) {
    return backToForm('Password must be at least 6 characters.');
  }

  try {
    await updatePasswordWithToken(access_token, password);
    res.redirect('/login?notice=' + encodeURIComponent('Your password has been updated — please log in.'));
  } catch (err) {
    backToForm(err.message || 'Could not update your password. Request a new reset link and try again.');
  }
});

// ─── Health check — no login required ──────────────────────────────────────
app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'hub' });
});

// ─── Insurance Compliance — internal/cron route, no login required ────────
// One endpoint (the nightly new-property check) authenticates with its own
// shared secret header instead of a browser session — same as it did
// before this migration. It has to be registered before requireLogin
// below, or the cron job's request would get redirected to /login and
// fail instead of running.
app.use(insuranceInternalRouter);

// ─── Security Deposit — internal/cron routes, no login required ───────────
// Three endpoints (create-cases-from-sync, send-reminders, index-b2-photos)
// each authenticate with the same shared secret header as
// insuranceInternalRouter above. Must also be registered before
// requireLogin, for the same reason. See security-deposit/router.js's
// file header for the full mounting-order explanation.
app.use(securityDepositInternalRouter);

// ─── Maintenance History — internal/cron routes, no login required ────────
// Two endpoints (internal/ingest — the nightly Latchel pull, and
// internal/reconcile-properties — the periodic property-matching pass)
// each authenticate with the same shared secret header as the other two
// tools' internal routers. Must also be registered before requireLogin.
app.use(maintenanceHistoryInternalRouter);

// ─── Everything below this line requires a valid, logged-in session ───────
app.use(requireLogin);

// ─── GET / — home page ──────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const email = req.session.userEmail || req.user.email;
  res.send(
    page({
      title: 'Home',
      body: `
        <div class="top-row">
          <h1>Rincon Hub</h1>
          <a href="/logout">Log out</a>
        </div>
        <p class="note" style="margin-top:0.25rem">Logged in as <strong>${escapeHtml(email)}</strong></p>
        <div class="section-list">
          <div class="section-list-label">Sections</div>
          <a class="section-link" href="/insurance">
            <strong>Insurance Compliance</strong>
            <span>Upload declaration pages, review coverage status, manage escalations</span>
          </a>
          <a class="section-link" href="/security-deposit">
            <strong>Security Deposit</strong>
            <span>Review move-out disposition packets before the 21-day deadline</span>
          </a>
          <a class="section-link" href="/maintenance-history">
            <strong>Maintenance History</strong>
            <span>Ticket timelines, decisions, and outcomes pulled from Latchel — every fact reviewed before it's trusted</span>
          </a>
        </div>
        <div class="note">More tools will show up here as they move into the hub.</div>
      `,
    })
  );
});

// ─── Insurance Compliance section ──────────────────────────────────────────
// Migrated from projects/insurance-compliance (see insurance/router.js for
// the full migration notes). Everyone reaching here is already a confirmed,
// logged-in hub user — requireLogin above already ran. insurance/router.js
// does its own additional check on top of that: does this specific person
// hold a role in Neo's team_member_tool_roles for tool='insurance_compliance'.
// No second sign-in screen — the old standalone Google sign-in page is gone.
app.use(insuranceRouter);

// ─── Security Deposit section ──────────────────────────────────────────────
// Same shape as Insurance Compliance above: everyone reaching here is
// already a confirmed, logged-in hub user (requireLogin already ran).
// security-deposit/router.js does its own additional check on top of
// that — does this specific person hold a role in
// team_member_tool_roles for tool='security_deposit'. See
// security-deposit/router.js and its SPEC.md for the full detail.
app.use(securityDepositRouter);

// ─── Maintenance History section ───────────────────────────────────────────
// Same shape again: requireLogin already ran; maintenance-history/router.js
// does its own additional check — does this specific person hold a role in
// team_member_tool_roles for tool='maintenance_history' ('reviewer' or
// 'admin'). See maintenance-history/router.js and its SPEC.md.
app.use(maintenanceHistoryRouter);

// ─── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Rincon Hub running on port ${PORT}`);
});
