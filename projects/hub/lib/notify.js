/**
 * lib/notify.js
 * Shared notification module — the Hub's one place to (a) look up who a
 * message should go to, and (b) actually send it.
 *
 * Replaces three separately-maintained copies of this same logic that had
 * grown up independently in insurance/router.js, security-deposit/router.js,
 * and archive-search/router.js — each with its own createMailer(), its own
 * nodemailer send-and-log code, and its own copy of "look up a role-holder's
 * email." One shared copy means a fix lands once, not three times.
 *
 * Schema this is built against: Neo's
 * supabase/migrations/20260918050000_notification_recipients_schema.sql
 * (team_members.pod, and the new shared_inboxes table). As of this build
 * that migration has NOT been applied to the live database yet — Peter
 * applies migrations himself, on his own timeline. See the pod-filter note
 * on getRoleHolders() below for how this module still works correctly
 * against TODAY's live schema in the meantime.
 *
 * ============================================================
 * RECIPIENT LOOKUPS — Neo's three patterns
 * ============================================================
 *   getPersonEmail(id)              One specific person, by their
 *                                    team_members id. Returns their email,
 *                                    or null if they don't exist or are
 *                                    inactive.
 *   getRoleHolders(tool, role, pod) Everyone currently holding `role` for
 *                                    `tool` in team_member_tool_roles.
 *                                    `role` can be one role name or an
 *                                    array of role names (Security
 *                                    Deposit's escalation email goes to
 *                                    both 'director_of_operations' and
 *                                    'admin' — one person can only hold
 *                                    one role per tool, so this can never
 *                                    double-count someone). Omit `pod` for
 *                                    "everyone who holds this role for
 *                                    this tool, tool-wide" — pass it
 *                                    ('Solimar' | 'Faria') to narrow to
 *                                    just that pod. Returns an array of
 *                                    emails, [] if nobody qualifies.
 *   getSharedInbox(key)              One shared/team inbox (a pod team
 *                                    address, or a role-style inbox like
 *                                    Director of Operations), by its
 *                                    shared_inboxes.key. Returns its
 *                                    email, or null if the key doesn't
 *                                    exist or is inactive.
 *
 * None of these throw. A lookup that can't run — the table/column doesn't
 * exist yet, a query error, nothing found — returns null/[] the same as a
 * genuine "nobody configured yet," same fail-closed posture every
 * attachXRole() middleware in this codebase already uses for the same
 * reason: a tool with no recipient configured should treat that as "no
 * recipients," not crash.
 *
 * PLAIN-ENGLISH NOTE ON THE POD COLUMN: getRoleHolders() only asks the
 * database for team_members.pod when a caller actually passes a `pod`
 * filter. That column is brand new and not live yet — if this function
 * asked for it on every call (matching Neo's example query literally),
 * every tool-wide lookup (every caller in this build — none of them pass a
 * pod filter, on purpose, see each router file) would break the moment
 * this ships, instead of only breaking the pod-filtered lookups nothing
 * calls yet. This is the one deliberate adaptation from Neo's example
 * queries — same underlying logic, just asking for the new column only
 * when it's actually needed.
 *
 * ============================================================
 * SENDING — sendMail({ to, subject, text })
 * ============================================================
 * Sends via the Gmail API using OAuth2 (GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET / HUB_NOTIFY_REFRESH_TOKEN) — not the Gmail-app-
 * password/nodemailer setup this module used before 2026-09-18 (and that
 * security-deposit/router.js's and archive-search/router.js's own
 * independent fallback alert still use — see below). Sends from a neutral
 * "Rincon Hub" <noreply@rinconmanagement.com> address, reusing the SAME
 * OAuth2 application (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) already
 * granted access by Peter's own account for calendar-assistant/
 * appfolio-sync — HUB_NOTIFY_REFRESH_TOKEN is a separate refresh token,
 * tied to the noreply@ account instead, obtained by running
 * setup-notify-oauth.js once (see that file). `to` can be a single
 * address or an array. Never throws — always resolves with:
 *   { ok, sent, failed, accepted, rejected, error }
 * so a caller can either just check `.ok` (most call sites) or read the
 * finer-grained accepted/rejected counts (Security Deposit's reminder
 * email, which reports real per-recipient outcomes back to its own
 * caller).
 *
 * HONEST LIMIT on accepted/rejected: unlike SMTP, the Gmail API's
 * messages.send does not report per-recipient accept/reject — it either
 * accepts the whole message for delivery (200, one message id, no
 * indication of which envelope recipients will actually receive it) or
 * the call itself fails. So a successful call here reports every
 * recipient as accepted and none rejected — that is the most honest thing
 * this API actually tells us, not a claim that every mailbox is confirmed
 * reachable the way SMTP's per-recipient response used to be.
 *
 * Every failure to send — mailer not configured, no recipient given, or
 * the send itself throwing — is logged here with a `[HUB-ALERT]` prefix,
 * so any tool's "a notification didn't go out" case is greppable in one
 * place in the server logs, instead of however each tool happened to
 * phrase it before.
 *
 * This does NOT replace either of security-deposit/router.js's and
 * archive-search/router.js's own hardcoded "something is fundamentally
 * broken, tell Peter no matter what" fallback alert (sendFailureAlertEmail
 * in each of those files). Those stay deliberately independent of this
 * module — their own nodemailer/GMAIL_USER+GMAIL_APP_PASSWORD setup, their
 * own hardcoded recipient — so a bug in THIS file (or in the noreply@
 * account's OAuth2 credentials specifically) can't also take out the
 * alert that this file is broken. Both of those fallbacks still log with
 * the same [HUB-ALERT] prefix too, for the same one-tag-to-grep reason,
 * but through their own self-contained code, not this one.
 */

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are already validated by
// hub/server.js before any router file (and therefore this module) is ever
// required — same "only check what's specific here" reasoning every
// router.js in this codebase already gives for its own client.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// Recipient lookups
// ============================================================

// 1. A specific named person, by their team_members id. Only returns an
// email for a currently-active member — same guard every existing
// role-holder lookup in this codebase already applies.
async function getPersonEmail(id) {
  if (!id) return null;
  try {
    const { data, error } = await supabase
      .from('team_members')
      .select('email, is_active')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    return (data && data.is_active) ? data.email : null;
  } catch (err) {
    console.error('[hub notify] getPersonEmail lookup failed:', err.message);
    return null;
  }
}

// 2. Everyone currently holding `role` (a string, or an array of role
// names) for `tool` in team_member_tool_roles. Pass `pod` to narrow to one
// pod's role-holder; omit it for tool-wide. See the file header for why
// team_members.pod is only requested when `pod` is actually passed.
async function getRoleHolders(tool, role, pod) {
  try {
    const fields = pod ? 'email, is_active, pod' : 'email, is_active';
    let query = supabase
      .from('team_member_tool_roles')
      .select(`team_members ( ${fields} )`)
      .eq('tool', tool);
    query = Array.isArray(role) ? query.in('role', role) : query.eq('role', role);
    const { data: rows, error } = await query;
    if (error) throw error;
    return (rows || [])
      .filter(r => r.team_members && r.team_members.is_active)
      .filter(r => !pod || r.team_members.pod === pod)
      .map(r => r.team_members.email);
  } catch (err) {
    console.error('[hub notify] getRoleHolders lookup failed:', err.message);
    return [];
  }
}

// 3. A shared/team inbox, by its stable key (e.g. 'faria_pod_team',
// 'director_of_operations') — see shared_inboxes in Neo's migration.
async function getSharedInbox(key) {
  if (!key) return null;
  try {
    const { data, error } = await supabase
      .from('shared_inboxes')
      .select('email, is_active')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    return (data && data.is_active) ? data.email : null;
  } catch (err) {
    console.error('[hub notify] getSharedInbox lookup failed:', err.message);
    return null;
  }
}

// ============================================================
// Sending
// ============================================================

// Returns a ready-to-use Gmail API client (never throws) if
// GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and HUB_NOTIFY_REFRESH_TOKEN are
// all set, or null if any are missing — sendMail() below treats null as
// "can't send" and reports it honestly instead of crashing the caller.
// HUB_NOTIFY_REFRESH_TOKEN is deliberately a different variable from
// GOOGLE_REFRESH_TOKEN (which stays tied to Peter's own account, used by
// calendar-assistant/appfolio-sync) — see setup-notify-oauth.js for how to
// obtain it.
function getGmailClient() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.HUB_NOTIFY_REFRESH_TOKEN) {
    return null;
  }
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.HUB_NOTIFY_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Sends one email to one or more recipients. Always resolves with
// { ok, sent, failed, accepted, rejected, error } — never throws — so a
// notification failure is always something the caller can report honestly
// (same discipline security-deposit/router.js's and archive-search/
// router.js's own sendEscalationEmail() already established) instead of a
// silent console.error nobody's watching. Every failure path logs here
// with a [HUB-ALERT] prefix — see the file header.
async function sendMail({ to, subject, text }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) {
    console.error(`[HUB-ALERT] Email not sent — no recipient given. Subject: "${subject}"`);
    return { ok: false, sent: 0, failed: 0, accepted: [], rejected: [], error: 'no_recipient' };
  }

  const gmail = getGmailClient();
  if (!gmail) {
    console.error(`[HUB-ALERT] Email not sent — mailer unavailable (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/HUB_NOTIFY_REFRESH_TOKEN not configured). Subject: "${subject}" To: ${recipients.join(', ')}`);
    return { ok: false, sent: 0, failed: recipients.length, accepted: [], rejected: [], error: 'mailer_not_configured' };
  }

  try {
    // RFC 2822 raw message, same shape calendar-assistant/
    // send-morning-email.js's sendEmail() already builds and sends
    // successfully in production — text body here (not html), matching
    // this function's own existing `text` parameter.
    const rawMessage = [
      `From: "Rincon Hub" <noreply@rinconmanagement.com>`,
      `To: ${recipients.join(', ')}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      text,
    ].join('\r\n');

    // Gmail API requires base64url encoding, not plain base64.
    const encoded = Buffer.from(rawMessage).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded },
    });

    // See the file header's "HONEST LIMIT" note: a successful call here
    // means Gmail accepted the message for delivery to every envelope
    // recipient — there's no per-recipient accept/reject signal the way
    // SMTP gave us, so every recipient is reported accepted.
    return { ok: true, sent: recipients.length, failed: 0, accepted: recipients, rejected: [], error: null };
  } catch (err) {
    console.error(`[HUB-ALERT] Email send failed — ${err.message}. Subject: "${subject}" To: ${recipients.join(', ')}`);
    return { ok: false, sent: 0, failed: recipients.length, accepted: [], rejected: [], error: err.message };
  }
}

module.exports = { getPersonEmail, getRoleHolders, getSharedInbox, sendMail };
