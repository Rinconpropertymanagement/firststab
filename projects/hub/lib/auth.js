/**
 * lib/auth.js
 * Wraps Supabase Auth (email + password) for the hub's login page.
 *
 * This is the same pattern already used by projects/content-review/lib/auth.js
 * — copied here (not imported cross-project) so the hub doesn't depend on
 * another app's internals. Supabase Auth users are shared across the whole
 * Supabase project, so anyone who can already log into content-review with
 * their email/password can log into the hub with the same credentials —
 * nothing new to create.
 *
 * Only the anon key is used here — nothing in this file uses the service
 * role key. Note: "the anon key is safe to expose client-side" is only
 * true when the key Supabase actually issued is the real, correctly-scoped
 * anon/public key (prefixed sb_publishable_...). Confirmed 2026-08-26 via a
 * live RLS test (a real request using only SUPABASE_ANON_KEY against
 * team_members/team_member_tool_roles came back empty, as it should) — an
 * earlier incident had a secret-tier key (sb_secret_...) mistakenly saved
 * under this env var name, which would have made this comment's safety
 * claim false. Re-verify with that same test after any future key
 * rotation before trusting this assumption again.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function getAuthClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Attempt to log in with email + password against Supabase Auth.
 * Returns { user, session } on success, throws on failure.
 */
async function signInWithPassword(email, password) {
  const client = getAuthClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(error.message || 'Invalid email or password');
  }
  return data; // { user, session }
}

/**
 * Verify an access token is still valid and return the user it belongs to.
 * Used on every page load to confirm the session cookie is real, not just
 * present — this is what makes the login a real gate rather than an
 * unlisted URL.
 */
async function getUserFromToken(accessToken) {
  if (!accessToken) return null;
  const client = getAuthClient();
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return data.user;
}

/**
 * Kick off Supabase's "forgot password" email for the given address.
 * redirectTo must point at THIS app's /reset-password page (not just the
 * site root) — that's the page with the "set new password" form, same
 * pattern already proven out by content-review's scripts/create-first-user.js.
 *
 * Deliberately never throws and never tells the caller whether the email
 * belongs to a real account — Supabase itself already stays silent about
 * unregistered emails (so guessing emails against this form can't be used
 * to find out who has an account), and this does the same for any other
 * failure (bad env config, Supabase being down, etc.) by only logging it
 * server-side. The route that calls this always shows the same "check your
 * email" message no matter what happens here.
 */
async function requestPasswordReset(email) {
  const client = getAuthClient();
  const baseUrl = process.env.HUB_BASE_URL || `http://localhost:${process.env.HUB_PORT || 3500}`;
  const { error } = await client.auth.resetPasswordForEmail(email, {
    redirectTo: `${baseUrl}/reset-password`,
  });
  if (error) {
    console.error('[requestPasswordReset] Supabase error:', error.message);
  }
}

/**
 * Set a new password for the user identified by a recovery access token.
 * Used by GET/POST /reset-password — the token comes from the "reset your
 * password" email link (Supabase's implicit flow puts it in the URL
 * fragment, which the browser sends to us via a small inline script; see
 * server.js). This does NOT log the person in on our side — after a
 * successful reset they're sent back to /login to sign in normally, same
 * as everyone else.
 *
 * This calls Supabase's REST API directly (same pattern as refreshSession
 * below) instead of going through the supabase-js client's
 * setSession()/updateUser(). Reason: a recovery link only gives us an access
 * token, not a refresh token, and this version of the client's setSession()
 * requires both (it throws "Auth session missing!" with just an access
 * token) — a real gap found while testing this against a live-generated
 * recovery link in content-review, where this exact function first proved
 * out. Calling PUT /auth/v1/user directly with the access token as the
 * bearer token works exactly the way Supabase's own docs describe for this
 * case, and avoids fighting the client's in-memory session state.
 */
async function updatePasswordWithToken(accessToken, newPassword) {
  if (!accessToken) {
    throw new Error('Missing or expired reset link. Request a new one.');
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    method: 'PUT',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: newPassword }),
  });
  if (!res.ok) {
    // Don't surface Supabase's raw error text (e.g. "invalid JWT: ...") —
    // it's not meaningful to someone resetting a password. Any failure
    // here means the token was bad, expired, or already used.
    throw new Error('That reset link is invalid or has expired. Request a new one.');
  }
}

/**
 * Exchange a refresh token for a new access token, without a password.
 * Used by requireLogin (lib/middleware.js) when the access token in the
 * session cookie has expired (Supabase access tokens are short-lived, ~1
 * hour) — this lets a still-active user keep working without being bounced
 * to /login and having to re-authenticate.
 *
 * Calls Supabase's REST API directly (POST /auth/v1/token?grant_type=refresh_token)
 * rather than going through the supabase-js client's setSession()/refreshSession(),
 * because getAuthClient() is created fresh per call with persistSession: false
 * and has no in-memory session state for those methods to use. Same approach
 * proven out in content-review's lib/auth.js.
 *
 * Returns { access_token, refresh_token } on success (Supabase rotates the
 * refresh token on every use, so the caller must store the new one, not
 * reuse the old one). Returns null if the refresh token is invalid/expired
 * — that's the caller's signal to give up and send the user to /login.
 */
async function refreshSession(refreshToken) {
  if (!refreshToken) return null;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    return null;
  }
  const data = await res.json();
  if (!data.access_token || !data.refresh_token) return null;
  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

module.exports = {
  getAuthClient,
  signInWithPassword,
  getUserFromToken,
  requestPasswordReset,
  updatePasswordWithToken,
  refreshSession,
};
