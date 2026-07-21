#!/usr/bin/env node
/**
 * monitor.js
 * Nightly insurance compliance monitor.
 *
 * Checks all current policies, updates statuses, sends emails, creates tasks.
 *
 * Usage:
 *   node monitor.js
 *   node monitor.js --help
 *
 * Cron on Sally: 0 3 * * *
 *
 * Required environment variables (in .env):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   GMAIL_CLIENT_ID
 *   GMAIL_CLIENT_SECRET
 *   GMAIL_REFRESH_TOKEN
 *
 * Optional:
 *   SYNC_ALERT_EMAIL_OPS    — additional alert recipient on failure
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

if (process.argv.includes('--help')) {
  console.log(`
monitor.js — Nightly insurance compliance monitor

Checks all current insurance policies and:
  - Marks expired policies as 'expired', emails PM and owner, creates urgent task
  - Marks policies expiring within 30 days as 'expiring_soon', emails PM, creates task

Usage:
  node monitor.js

Cron on Sally:
  0 3 * * *   (3am daily)

Environment variables required (.env file):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  GMAIL_CLIENT_ID
  GMAIL_CLIENT_SECRET
  GMAIL_REFRESH_TOKEN
  SYNC_ALERT_EMAIL_OPS   (optional — additional failure alert recipient)
`);
  process.exit(0);
}

const { google }       = require('googleapis');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ───────────────────────────────────────────────────────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const OPS_EMAIL     = process.env.SYNC_ALERT_EMAIL_OPS;
const PETER_EMAIL   = 'peter@rinconmanagement.com';

const missing = [];
if (!SUPABASE_URL)  missing.push('SUPABASE_URL');
if (!SUPABASE_KEY)  missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (!CLIENT_ID)     missing.push('GMAIL_CLIENT_ID');
if (!CLIENT_SECRET) missing.push('GMAIL_CLIENT_SECRET');
if (!REFRESH_TOKEN) missing.push('GMAIL_REFRESH_TOKEN');

if (missing.length > 0) {
  console.error(`[ERROR] Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Gmail send ───────────────────────────────────────────────────────────────
// Same OAuth2 pattern as calendar-assistant/send-morning-email.js
async function sendEmail({ to, subject, body }) {
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const rawMessage = [
    `From: "Rincon Management" <${PETER_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ].join('\r\n');

  const encoded = Buffer.from(rawMessage).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded },
  });
  return response.data;
}

// ─── Email templates ──────────────────────────────────────────────────────────
function daysBetween(dateStr) {
  const exp  = new Date(dateStr + 'T12:00:00');
  const now  = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((exp - now) / (1000 * 60 * 60 * 24));
}

function expiringSoonEmail(policy, property) {
  const days    = daysBetween(policy.expiration_date);
  const address = property.address || property.name || policy.appfolio_property_id;
  return {
    subject: `Insurance expiring in ${days} days — ${property.name || address}`,
    body: `The insurance policy for ${address} (Policy #${policy.policy_number || 'N/A'}, ${policy.insurer_name || 'unknown insurer'}) expires on ${policy.expiration_date}.

Please contact the owner to arrange renewal and upload the new declaration page when it is available.

This is an automated message from the Rincon Management compliance system.`,
  };
}

function expiredPmEmail(policy, property) {
  const address = property.address || property.name || policy.appfolio_property_id;
  return {
    subject: `URGENT: Insurance expired — ${property.name || address}`,
    body: `The insurance policy for ${address} expired on ${policy.expiration_date}.

Please contact the owner immediately.

This is an automated message from the Rincon Management compliance system.`,
  };
}

function expiredOwnerEmail(policy, property) {
  const address = property.address || property.name || policy.appfolio_property_id;
  return {
    subject: `Insurance renewal needed — ${address}`,
    body: `Our records show the insurance policy for your property at ${address} expired on ${policy.expiration_date}.

Please provide updated insurance information as soon as possible. When you provide the new policy, please ensure that Rincon Property Management is listed as an additional insured party on the declarations page.

Please reply to this email or contact your property manager directly.

Rincon Management`,
  };
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function lookupPm(pod) {
  if (!pod) return null;
  const { data } = await supabase
    .from('users')
    .select('id, email')
    .eq('role', 'Property Manager')
    .eq('pod', pod)
    .limit(1);
  return (data && data.length > 0) ? data[0] : null;
}

async function lookupOwnerEmail(appfolio_property_id) {
  const { data } = await supabase
    .from('owners')
    .select('email')
    .eq('appfolio_id',
      supabase.from('property_owners')
        .select('appfolio_owner_id')
        .eq('appfolio_property_id', appfolio_property_id)
        .limit(1)
    )
    .limit(1);
  // Fallback: direct join via raw query
  try {
    const { data: rows } = await supabase.rpc
      ? await supabase
          .from('property_owners')
          .select('owners!inner(email)')
          .eq('appfolio_property_id', appfolio_property_id)
          .limit(1)
      : { data: null };
    if (rows && rows.length > 0 && rows[0].owners) {
      return rows[0].owners.email || null;
    }
  } catch {
    // best-effort — owner email is optional
  }
  return null;
}

async function hasOpenTask(propertyId, workflowType) {
  const { data } = await supabase
    .from('tasks')
    .select('id')
    .eq('entity_id', propertyId)
    .eq('workflow_type', workflowType)
    .in('status', ['open', 'in_progress'])
    .limit(1);
  return data && data.length > 0;
}

async function logCommunication(record) {
  const { error } = await supabase.from('communications_log').insert(record);
  if (error) console.warn(`[monitor] communications_log warn: ${error.message}`);
}

async function logAudit(record) {
  const { error } = await supabase.from('audit_log').insert(record);
  if (error) console.warn(`[monitor] audit_log warn: ${error.message}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date().toISOString();
  console.log(`[${now}] Insurance monitor starting`);

  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  const in30Days = new Date(today);
  in30Days.setDate(today.getDate() + 30);

  // Fetch all current policies with property details
  const { data: policies, error: fetchErr } = await supabase
    .from('property_insurance')
    .select(`
      *,
      properties!left(name, address, pod, appfolio_id, id)
    `)
    .eq('is_current', true);

  if (fetchErr) throw new Error(`Failed to fetch policies: ${fetchErr.message}`);
  console.log(`[${now}] ${policies.length} current policies to check`);

  let expired = 0;
  let expiringSoon = 0;

  for (const policy of policies) {
    const property    = policy.properties || {};
    const propertyId  = property.id || policy.property_id;
    const expDate     = new Date(policy.expiration_date + 'T12:00:00');

    // ── Expired ──────────────────────────────────────────────────────────────
    if (expDate <= today && policy.status !== 'expired') {
      console.log(`[${now}] EXPIRED: ${policy.appfolio_property_id} (${policy.expiration_date})`);

      await supabase
        .from('property_insurance')
        .update({ status: 'expired', updated_at: new Date().toISOString() })
        .eq('id', policy.id);

      const pm         = await lookupPm(property.pod);
      const ownerEmail = await lookupOwnerEmail(policy.appfolio_property_id);

      // Email PM
      if (pm && pm.email) {
        try {
          const email = expiredPmEmail(policy, property);
          await sendEmail({ to: pm.email, ...email });
          await logCommunication({
            recipient_email: pm.email,
            subject:         email.subject,
            type:            'insurance_expired_pm',
            entity_type:     'property',
            entity_id:       propertyId,
          });
          console.log(`[${now}]   Expired email sent to PM: ${pm.email}`);
        } catch (err) {
          console.error(`[${now}]   PM email error: ${err.message}`);
        }
      }

      // Email owner
      if (ownerEmail) {
        try {
          const email = expiredOwnerEmail(policy, property);
          await sendEmail({ to: ownerEmail, ...email });
          await logCommunication({
            recipient_email: ownerEmail,
            subject:         email.subject,
            type:            'insurance_expired_owner',
            entity_type:     'property',
            entity_id:       propertyId,
          });
          console.log(`[${now}]   Expired email sent to owner: ${ownerEmail}`);
        } catch (err) {
          console.error(`[${now}]   Owner email error: ${err.message}`);
        }
      }

      // Create task if none already open
      const alreadyHasTask = propertyId ? await hasOpenTask(propertyId, 'insurance_compliance') : false;
      if (!alreadyHasTask) {
        const { error: taskErr } = await supabase.from('tasks').insert({
          title:         `URGENT: Insurance expired — ${property.name || policy.appfolio_property_id}`,
          entity_type:   'property',
          entity_id:     propertyId || null,
          assigned_to:   pm ? pm.id : null,
          workflow_type: 'insurance_compliance',
          priority:      'urgent',
          status:        'open',
          due_date:      new Date().toISOString().slice(0, 10), // due today
        });
        if (taskErr) console.warn(`[${now}]   Task insert warn: ${taskErr.message}`);
        else console.log(`[${now}]   Urgent task created`);
      }

      await logAudit({
        action:      'insurance.expired',
        entity_type: 'property',
        entity_id:   propertyId || null,
        details:     { policy_number: policy.policy_number, expiration_date: policy.expiration_date },
      });

      expired++;

    // ── Expiring soon ─────────────────────────────────────────────────────────
    } else if (expDate > today && expDate <= in30Days && policy.status === 'compliant') {
      console.log(`[${now}] EXPIRING SOON: ${policy.appfolio_property_id} (${policy.expiration_date})`);

      await supabase
        .from('property_insurance')
        .update({ status: 'expiring_soon', updated_at: new Date().toISOString() })
        .eq('id', policy.id);

      const pm = await lookupPm(property.pod);

      if (pm && pm.email) {
        try {
          const email = expiringSoonEmail(policy, property);
          await sendEmail({ to: pm.email, ...email });
          await logCommunication({
            recipient_email: pm.email,
            subject:         email.subject,
            type:            'insurance_expiring_soon',
            entity_type:     'property',
            entity_id:       propertyId,
          });
          console.log(`[${now}]   Expiring soon email sent to PM: ${pm.email}`);
        } catch (err) {
          console.error(`[${now}]   PM email error: ${err.message}`);
        }
      }

      const alreadyHasTask = propertyId ? await hasOpenTask(propertyId, 'insurance_compliance') : false;
      if (!alreadyHasTask) {
        // Task due 7 days before expiration
        const dueDate = new Date(expDate);
        dueDate.setDate(dueDate.getDate() - 7);

        const { error: taskErr } = await supabase.from('tasks').insert({
          title:         `Insurance expiring soon — ${property.name || policy.appfolio_property_id}`,
          entity_type:   'property',
          entity_id:     propertyId || null,
          assigned_to:   pm ? pm.id : null,
          workflow_type: 'insurance_compliance',
          priority:      'high',
          status:        'open',
          due_date:      dueDate.toISOString().slice(0, 10),
        });
        if (taskErr) console.warn(`[${now}]   Task insert warn: ${taskErr.message}`);
        else console.log(`[${now}]   High-priority task created (due ${dueDate.toISOString().slice(0, 10)})`);
      }

      await logAudit({
        action:      'insurance.expiring_soon',
        entity_type: 'property',
        entity_id:   propertyId || null,
        details:     { policy_number: policy.policy_number, expiration_date: policy.expiration_date },
      });

      expiringSoon++;
    }
  }

  console.log(`[${new Date().toISOString()}] Done. Expired: ${expired} | Expiring soon: ${expiringSoon}`);
}

// ─── Run ──────────────────────────────────────────────────────────────────────
main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    const ts = new Date().toISOString();
    console.error(`[${ts}] FATAL:`, err.message);

    // Send failure alert
    const subject = `Insurance monitor failed — ${ts}`;
    const body    = `The nightly insurance compliance monitor failed at ${ts}.\n\nError: ${err.message}\n\nStack:\n${err.stack}`;
    const alerts  = [PETER_EMAIL, OPS_EMAIL].filter(Boolean);

    for (const to of alerts) {
      try {
        await sendEmail({ to, subject, body });
        console.error(`[${ts}] Alert sent to ${to}`);
      } catch (emailErr) {
        console.error(`[${ts}] Failed to send alert to ${to}: ${emailErr.message}`);
      }
    }

    process.exit(1);
  });
