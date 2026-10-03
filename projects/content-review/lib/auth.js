/**
 * lib/auth.js
 * Wraps Supabase Auth (email + password) for this app's login page.
 *
 * Two clients on purpose:
 *  - adminClient (service role key): used ONE TIME by scripts/create-first-user.js
 *    to create Peter's account. Never used on the login request path.
 *  - authClient (anon key): used to verify a submitted password against
 *    Supabase Auth on every login attempt.
 *
 * Note: "the anon key is safe client-side" only holds when the key
 * Supabase actually issued is the real, correctly-scoped anon/public key
 * (prefixed sb_publishable_...). Confirmed 2026-08-26 via a live RLS test
 * (a request using only SUPABASE_ANON_KEY against team_members/
 * team_member_tool_roles came back empty, as it should) — an earlier
 * incident had a secret-tier key (sb_secret_...) mistakenly saved under
 * this env var name, which would have made this claim false. Re-verify
 * with that same test after any future key rotation before trusting this
 * assumption again.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function getAuthClient() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function getAdminClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
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
 * present — this is what makes login "real" rather than security-through-
 * obscurity (an unlisted URL would not do this check).
 */
async function getUserFromToken(accessToken) {
  if (!accessToken) return null;
  const client = getAuthClient();
  const { data, error } = await client.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return data.user;
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
 * This calls Supabase's REST API directly (same pattern as lib/db.js)
 * instead of going through the supabase-js client's setSession()/updateUser().
 * Reason: a recovery link only gives us an access token, not a refresh
 * token, and this version of the client's setSession() requires both (it
 * throws "Auth session missing!" with just an access token) — a real gap
 * found while testing this against a live-generated recovery link. Calling
 * PUT /auth/v1/user directly with the access token as the bearer token
 * works exactly the way Supabase's own docs describe for this case, and
 * avoids fighting the client's in-memory session state.
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
 * Same reasoning as updatePasswordWithToken above: this calls Supabase's
 * REST API directly (POST /auth/v1/token?grant_type=refresh_token) instead
 * of going through the supabase-js client's setSession()/refreshSession().
 * Those methods expect the client to hold in-memory session state that this
 * server never establishes (getAuthClient() is created fresh per call with
 * persistSession: false) — calling the token endpoint directly is the same
 * "don't fight the client's session state" approach already proven out for
 * password resets.
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
    // Refresh token missing, expired, or already used — caller should treat
    // this exactly like "not logged in" and redirect to /login.
    return null;
  }
  const data = await res.json();
  if (!data.access_token || !data.refresh_token) return null;
  return { access_token: data.access_token, refresh_token: data.refresh_token };
}

module.exports = {
  getAuthClient,
  getAdminClient,
  signInWithPassword,
  getUserFromToken,
  updatePasswordWithToken,
  refreshSession,
};
