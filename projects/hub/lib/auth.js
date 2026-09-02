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

// How long to wait for a response from Supabase's Auth service (not the
// database — that's a separate, unrelated service and stays fast) before
// giving up and telling the user to try again instead of hanging forever.
// Confirmed live 2026-08-26: one real call to Supabase Auth from the
// production server took 75+ seconds while 6 immediate retries were all
// under 0.2s and the database REST API stayed fast throughout — this is
// intermittent external network flakiness to that one service, not
// something we can fix, only bound.
const AUTH_TIMEOUT_MS = 9000;

/**
 * Thrown by signInWithPassword / getUserFromToken / refreshSession
 * specifically when Supabase's Auth service didn't answer in time (or a
 * lower-level network error came back instead of a real response) — NOT
 * when credentials are wrong or a token/refresh token is genuinely invalid.
 * Callers check for this (`instanceof AuthTimeoutError`) to show an honest
 * "try again" message instead of "wrong password" or "you're logged out."
 */
class AuthTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthTimeoutError';
  }
}

// Pass timeoutMs to bound how long this client will wait on any Auth call
// before aborting. Omit it (as requestPasswordReset does) to keep the
// client's default (no timeout) — deliberately opt-in per call site so this
// change stays scoped to the functions that needed it.
function getAuthClient(timeoutMs) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  }
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  if (timeoutMs) {
    options.global = {
      fetch: (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) }),
    };
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, options);
}

/**
 * Attempt to log in with email + password against Supabase Auth.
 * Returns { user, session } on success, throws on failure.
 */
async function signInWithPassword(email, password) {
  const client = getAuthClient(AUTH_TIMEOUT_MS);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.name === 'AuthRetryableFetchError') {
      // supabase-js's own name for "the fetch itself failed" — covers both
      // our timeout aborting the request and any other network-level
      // failure reaching Supabase Auth. Distinct from a real credential
      // rejection (AuthApiError, e.g. wrong password), which still falls
      // through to the message below unchanged.
      throw new AuthTimeoutError('Login is taking too long right now — please try again.');
    }
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
  const client = getAuthClient(AUTH_TIMEOUT_MS);
  let { data, error } = await client.auth.getUser(accessToken);

  if (error && error.name === 'AuthRetryableFetchError') {
    // This runs on every page load for an already-logged-in person, so a
    // single transient hiccup (see AUTH_TIMEOUT_MS above) shouldn't look
    // like "you're logged out." One quick retry before treating it as a
    // real problem.
    ({ data, error } = await client.auth.getUser(accessToken));
  }

  if (error && error.name === 'AuthRetryableFetchError') {
    // Still couldn't reach Supabase Auth after a retry. This is NOT the
    // same as an invalid/expired token (that's the `return null` below,
    // unchanged) — returning null here would tell requireLogin to treat an
    // already-logged-in person as logged out. Throw instead so the caller
    // can tell the two apart.
    throw new AuthTimeoutError('Could not verify your session right now — the login service is slow to respond.');
  }

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
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    });
  } catch (err) {
    // Timeout or network-level failure reaching Supabase Auth — same gap as
    // signInWithPassword/getUserFromToken above. NOT the same as "refresh
    // token is invalid" (that's the !res.ok case below, still returns null
    // unchanged) — throw so the caller can tell the two apart.
    throw new AuthTimeoutError('Could not refresh your session right now — the login service is slow to respond.');
  }
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
  AuthTimeoutError,
};
