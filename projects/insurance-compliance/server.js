#!/usr/bin/env node
/**
 * server.js
 * Express server for the insurance compliance upload workflow.
 *
 * Endpoints:
 *   POST /api/insurance/upload  — Upload a declaration page, extract fields
 *   POST /api/insurance/save    — Save verified policy data
 *
 * Usage:
 *   node server.js
 *   node server.js --help
 *
 * Required environment variables (in .env):
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional:
 *   INSURANCE_PORT  (default: 3456)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

if (process.argv.includes('--help')) {
  console.log(`
server.js — Insurance compliance upload server

POST /api/insurance/upload
  Multipart form: file (PDF/JPG/PNG) + appfolio_property_id (text)
  Returns: document_id, property info, extracted policy fields

POST /api/insurance/save
  JSON body with verified policy fields
  Returns: { success: true, insurance_id }

Environment variables required (.env file):
  ANTHROPIC_API_KEY
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  INSURANCE_PORT  (optional, default 3456)
`);
  process.exit(0);
}

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { createClient } = require('@supabase/supabase-js');
const { extractPolicy } = require('./extract-policy');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT    = process.env.INSURANCE_PORT || 3456;
const missing = [];
if (!process.env.ANTHROPIC_API_KEY)          missing.push('ANTHROPIC_API_KEY');
if (!process.env.SUPABASE_URL)               missing.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY)  missing.push('SUPABASE_SERVICE_ROLE_KEY');

if (missing.length > 0) {
  console.error(`[ERROR] Missing environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Multer (file upload) ─────────────────────────────────────────────────────
// Save to /tmp with a timestamped name so concurrent uploads don't collide
const upload = multer({
  storage: multer.diskStorage({
    destination: '/tmp',
    filename: (req, file, cb) => {
      const ts = Date.now();
      cb(null, `insurance-upload-${ts}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Accepted: ${allowed.join(', ')}`));
    }
  },
});

// ─── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Allow all origins — dashboard and server may be on different ports
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── POST /api/insurance/upload ───────────────────────────────────────────────
app.post('/api/insurance/upload', upload.single('file'), async (req, res) => {
  const ts = new Date().toISOString();
  const appfolio_property_id = req.body.appfolio_property_id;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  if (!appfolio_property_id) {
    return res.status(400).json({ error: 'appfolio_property_id is required.' });
  }

  const filePath     = req.file.path;
  const originalName = req.file.originalname;
  const ext          = path.extname(originalName).toLowerCase();

  const MIME_MAP = {
    '.pdf':  'application/pdf',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
  };
  const mimeType = MIME_MAP[ext] || 'application/octet-stream';

  console.log(`[${ts}] Upload: ${originalName} | property: ${appfolio_property_id}`);

  // Step 1: Extract policy fields via Claude
  let extracted;
  try {
    extracted = await extractPolicy(filePath);
    console.log(`[${ts}] Extraction done. policy_number=${extracted.policy_number}`);
  } catch (err) {
    console.error(`[${ts}] Extraction error:`, err.message);
    return res.status(500).json({ error: 'Failed to extract policy fields.', detail: err.message });
  }

  // Step 2: Look up the property in Supabase
  let propertyId   = null;
  let propertyName = null;
  try {
    const { data: props } = await supabase
      .from('properties')
      .select('id, name, address')
      .eq('appfolio_id', appfolio_property_id)
      .limit(1);
    if (props && props.length > 0) {
      propertyId   = props[0].id;
      propertyName = props[0].name;
    }
  } catch (err) {
    // Non-fatal — property lookup failure shouldn't block the upload
    console.warn(`[${ts}] Property lookup warning:`, err.message);
  }

  // Step 3: Build the target path on Sally (file copy happens in a future storeDocument step)
  const year        = new Date().getFullYear();
  const targetPath  = `/var/www/documents/insurance_certificate/${year}/${Date.now()}-${appfolio_property_id}${ext}`;

  // Step 4: Insert a row into documents
  const { data: docRows, error: docErr } = await supabase
    .from('documents')
    .insert({
      file_name:   originalName,
      file_path:   targetPath,
      file_type:   'insurance_certificate',
      entity_type: 'property',
      entity_id:   propertyId,
      mime_type:   mimeType,
    })
    .select('id')
    .single();

  if (docErr) {
    console.error(`[${ts}] documents insert error:`, docErr.message);
    return res.status(500).json({ error: 'Failed to save document record.', detail: docErr.message });
  }

  // Clean up the temp file after processing
  fs.unlink(filePath, () => {});

  return res.json({
    document_id:           docRows.id,
    appfolio_property_id,
    property_name:         propertyName,
    extracted,
  });
});

// ─── POST /api/insurance/save ─────────────────────────────────────────────────
app.post('/api/insurance/save', async (req, res) => {
  const ts = new Date().toISOString();
  const {
    appfolio_property_id,
    property_id,
    document_id,
    policy_number,
    insurer_name,
    effective_date,
    expiration_date,
    coverage_amount,
    named_insured,
    property_address_on_policy,
    additional_insured_verified,
    coverage_amount_verified,
    notes,
  } = req.body;

  // Validation
  if (!expiration_date) {
    return res.status(400).json({ error: 'expiration_date is required.' });
  }
  if (!additional_insured_verified) {
    return res.status(400).json({ error: 'additional_insured_verified must be true before saving.' });
  }
  if (!coverage_amount_verified) {
    return res.status(400).json({ error: 'coverage_amount_verified must be true before saving.' });
  }

  console.log(`[${ts}] Save policy: property=${appfolio_property_id} policy#=${policy_number}`);

  // Step 1: Mark previous current policy as not current
  const { error: updateErr } = await supabase
    .from('property_insurance')
    .update({ is_current: false, updated_at: new Date().toISOString() })
    .eq('appfolio_property_id', appfolio_property_id)
    .eq('is_current', true);

  if (updateErr) {
    console.error(`[${ts}] Update previous policy error:`, updateErr.message);
    return res.status(500).json({ error: 'Failed to update previous policy.', detail: updateErr.message });
  }

  // Step 2: Insert new policy row
  const now = new Date().toISOString();
  const { data: insRows, error: insErr } = await supabase
    .from('property_insurance')
    .insert({
      appfolio_property_id,
      property_id:                property_id || null,
      document_id:                document_id || null,
      policy_number,
      insurer_name,
      effective_date:             effective_date || null,
      expiration_date,
      coverage_amount:            coverage_amount || null,
      named_insured:              named_insured || null,
      property_address_on_policy: property_address_on_policy || null,
      additional_insured_verified: !!additional_insured_verified,
      coverage_amount_verified:    !!coverage_amount_verified,
      notes:                      notes || null,
      is_current:                 true,
      status:                     'compliant',
      verified_at:                now,
    })
    .select('id')
    .single();

  if (insErr) {
    console.error(`[${ts}] property_insurance insert error:`, insErr.message);
    return res.status(500).json({ error: 'Failed to save insurance record.', detail: insErr.message });
  }

  const insuranceId = insRows.id;

  // Step 3: Insert workflow_instances row
  const { error: wfErr } = await supabase
    .from('workflow_instances')
    .insert({
      workflow_type: 'insurance_compliance',
      entity_type:   'property',
      entity_id:     property_id || null,
      status:        'completed',
      completed_at:  now,
    });

  if (wfErr) {
    // Non-fatal — log and continue
    console.warn(`[${ts}] workflow_instances insert warning:`, wfErr.message);
  }

  // Step 4: Insert audit_log row
  const { error: auditErr } = await supabase
    .from('audit_log')
    .insert({
      action:      'insurance.verified',
      entity_type: 'property',
      entity_id:   property_id || null,
      details:     { policy_number, expiration_date, document_id },
    });

  if (auditErr) {
    console.warn(`[${ts}] audit_log insert warning:`, auditErr.message);
  }

  console.log(`[${ts}] Policy saved. insurance_id=${insuranceId}`);
  return res.json({ success: true, insurance_id: insuranceId });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Insurance server running on port ${PORT}`);
});
