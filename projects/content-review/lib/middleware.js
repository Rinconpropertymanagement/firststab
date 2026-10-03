/**
 * lib/middleware.js
 * Login-wall middleware. Every page in this app (except /login) runs this
 * first. It checks the session cookie against Supabase Auth for real — it
 * does not just check "is there a cookie," it verifies the cookie's token
 * is a currently-valid Supabase session. This is what makes the login a
 * real gate rather than an unlisted URL.
 *
 * Supabase access tokens are short-lived (~1 hour). Rather than bouncing an
 * active user to /login the moment their access token expires mid-session,
 * this attempts one silent refresh using the long-lived refresh token
 * stored alongside it (see POST /login in server.js). If the refresh
 * succeeds, the request proceeds normally and the user never notices. Only
 * if the refresh token is ALSO invalid/expired (e.g. after days of
 * inactivity, past the cookie's own maxAge, or after a password reset
 * elsewhere invalidates it) do we actually force re-login.
 */

const { getUserFromToken, refreshSession } = require('./auth');

async function requireLogin(req, res, next) {
  const token = req.session && req.session.accessToken;
  if (!token) {
    return res.redirect('/login');
  }

  let user = await getUserFromToken(token);

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

  req.user = user;
  next();
}

module.exports = { requireLogin };
