/**
 * lib/middleware.js
 * Login-wall middleware. Every page in the hub (except /login) runs this
 * first. It checks the session cookie against Supabase Auth for real — it
 * does not just check "is there a cookie," it verifies the cookie's token
 * is a currently-valid Supabase session. This is what makes the login a
 * real gate rather than an unlisted URL.
 *
 * Supabase access tokens are short-lived (~1 hour). Rather than bouncing an
 * active user to /login the moment their access token expires mid-session,
 * this attempts one silent refresh using the long-lived refresh token
 * stored alongside it (see POST /login in server.js). Only if the refresh
 * token is ALSO invalid/expired does this force re-login.
 *
 * Same pattern as projects/content-review/lib/middleware.js, copied rather
 * than imported so the hub doesn't depend on another app's internals.
 */

const { getUserFromToken, refreshSession, AuthTimeoutError } = require('./auth');

// Shown instead of silently bouncing to /login when getUserFromToken /
// refreshSession couldn't reach Supabase Auth in time (see AUTH_TIMEOUT_MS
// in lib/auth.js). Deliberately does NOT touch req.session — the person is
// still logged in, we just couldn't confirm it, so a plain reload is enough
// once the hiccup clears. "Try again" links home rather than back to the
// page that was loading, to avoid echoing request data into HTML.
const AUTH_TIMEOUT_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>One moment — Rincon Hub</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f4; color: #1c1917; margin: 0; }
    .wrap { max-width: 420px; margin: 10vh auto; padding: 2rem; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); text-align: center; }
    h1 { font-size: 1.125rem; margin-top: 0; }
    p { color: #57534e; font-size: 0.9375rem; }
    a.retry { display: inline-block; margin-top: 1rem; padding: 0.6rem 1.5rem; background: #1c1917; color: #fff; border-radius: 4px; text-decoration: none; font-size: 0.9375rem; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Hang on a second</h1>
    <p>You're still logged in — we just couldn't confirm it in time. This is usually a brief hiccup on the login service. Please try again.</p>
    <a class="retry" href="/">Try again</a>
  </div>
</body>
</html>`;

async function requireLogin(req, res, next) {
  const token = req.session && req.session.accessToken;
  if (!token) {
    return res.redirect('/login');
  }

  let user;
  try {
    user = await getUserFromToken(token);

    if (!user) {
      // Access token missing/expired/invalid. Before giving up, try to
      // silently refresh using the stored refresh token.
      const refreshToken = req.session && req.session.refreshToken;
      const refreshed = refreshToken ? await refreshSession(refreshToken) : null;

      if (refreshed) {
        // Supabase rotates the refresh token on every use — store both new
        // values, or the NEXT refresh attempt will fail with a reused token.
        req.session.accessToken = refreshed.access_token;
        req.session.refreshToken = refreshed.refresh_token;
        user = await getUserFromToken(refreshed.access_token);
      }

      if (!user) {
        // Refresh also failed — the refresh token itself is expired/invalid.
        // Nothing left to try; force re-login rather than guessing.
        req.session.destroy(() => {});
        return res.redirect('/login');
      }
    }
  } catch (err) {
    if (err instanceof AuthTimeoutError) {
      // Supabase Auth didn't respond in time, even after getUserFromToken's
      // internal retry. NOT the same as "not logged in" — see the constant
      // above for why this doesn't redirect to /login or touch the session.
      return res.status(503).send(AUTH_TIMEOUT_PAGE);
    }
    throw err;
  }

  // At this point we know: valid, currently-logged-in Supabase Auth user.
  // req.user is the Supabase Auth user object (id, email, etc).
  req.user = user;

  // ── FUTURE: role / permission enforcement ──────────────────────────────
  // Neo is designing a shared "who's a valid team member and what can they
  // access" table in Supabase right now (see CLAUDE.md's Database section —
  // Neo owns schema, this file intentionally does NOT guess the table name
  // or columns). Once that table exists, this is the spot to look up
  // req.user's role/permissions (keyed by req.user.email or req.user.id)
  // and attach it, e.g. `req.user.role = ...`.
  //
  // From there, a route-level guard can be added alongside requireLogin,
  // similar to insurance-compliance's requireRole() in server.js:
  //
  //   function requireRole(...allowedRoles) {
  //     return (req, res, next) => {
  //       if (!allowedRoles.includes(req.user.role)) {
  //         return res.status(403).send('Forbidden');
  //       }
  //       next();
  //     };
  //   }
  //
  // Don't build requireRole until Neo's table exists — right now every
  // logged-in Supabase Auth user is treated as allowed into the hub itself.
  // Per-section access (e.g. who can open /insurance) gets layered in here
  // later, not decided by this file today.

  next();
}

module.exports = { requireLogin };
