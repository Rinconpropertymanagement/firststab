#!/usr/bin/env node
/**
 * scripts/create-first-user.js
 * One-time setup: creates exactly one login for this review app — Peter's
 * account. Run this once before Peter uses the app for the first time.
 *
 * Usage:
 *   node scripts/create-first-user.js
 *
 * What it does:
 *   - Creates a Supabase Auth user for peter@rinconmanagement.com with a
 *     random temporary password that nobody actually uses.
 *   - Immediately sends a password-reset email (via Supabase's built-in
 *     "reset password" flow) so Peter sets his own password before first
 *     login. Nobody, including this script, ever sees Peter's real password.
 *   - Safe to re-run: if the user already exists, it skips creation and
 *     just re-sends the reset email.
 */

// Same dual-path logic as server.js: prefer a .env sitting next to the app
// root (server deployment layout), fall back to the shared project-root
// .env (local dev's nested repo layout).
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '..', '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });
}
const { getAdminClient, getAuthClient } = require('../lib/auth');

const PETER_EMAIL = 'peter@rinconmanagement.com';

async function main() {
  const admin = getAdminClient();

  console.log(`Checking whether ${PETER_EMAIL} already has an account...`);
  const { data: existing, error: listErr } = await admin.auth.admin.listUsers();
  if (listErr) {
    throw new Error(`Could not list existing users: ${listErr.message}`);
  }
  const alreadyExists = existing.users.find((u) => u.email === PETER_EMAIL);

  if (!alreadyExists) {
    // Random throwaway password — Peter will never use this; he sets his
    // own via the reset-password email sent below.
    const throwawayPassword = require('crypto').randomBytes(24).toString('base64url');

    const { data, error } = await admin.auth.admin.createUser({
      email: PETER_EMAIL,
      password: throwawayPassword,
      email_confirm: true, // skip email confirmation step; we go straight to password reset
    });
    if (error) {
      throw new Error(`Could not create user: ${error.message}`);
    }
    console.log(`✓ Created account for ${PETER_EMAIL} (user id: ${data.user.id})`);
  } else {
    console.log(`Account for ${PETER_EMAIL} already exists (user id: ${alreadyExists.id}) — skipping creation.`);
  }

  console.log(`Sending password-reset email to ${PETER_EMAIL}...`);
  const authClient = getAuthClient();
  // redirectTo must point at the /reset-password landing page (not just the
  // site root) — that's the page that actually has the "set new password"
  // form. Falls back to localhost if RESET_PASSWORD_BASE_URL isn't set.
  const baseUrl = process.env.RESET_PASSWORD_BASE_URL || 'http://localhost:3300';
  const { error: resetErr } = await authClient.auth.resetPasswordForEmail(PETER_EMAIL, {
    redirectTo: `${baseUrl}/reset-password`,
  });
  if (resetErr) {
    console.warn(
      `[WARNING] Could not send reset email automatically (${resetErr.message}). ` +
      `Peter can still set his password from the Supabase dashboard under ` +
      `Authentication > Users > ${PETER_EMAIL} > "Send password recovery".`
    );
  } else {
    console.log(`✓ Password-reset email sent to ${PETER_EMAIL}.`);
  }

  console.log(`\nDone. Before first login, Peter must:`);
  console.log(`  1. Check ${PETER_EMAIL} inbox for a "Reset your password" email from Supabase.`);
  console.log(`  2. Click the link and set a real password.`);
  console.log(`  3. Log in at the review app with that email + password.`);
}

main().catch((err) => {
  console.error(`\n[ERROR] ${err.message}`);
  process.exit(1);
});
