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
const crypto     = require('crypto');
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
app.use(express.json({ limit: '100mb' }));

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

// ─── PATCH /api/insurance/policy/:id ─────────────────────────────────────────
app.patch('/api/insurance/policy/:id', async (req, res) => {
  const allowed = ['additional_insured_verified', 'coverage_amount_verified'];
  const updates = {};
  for (const field of allowed) {
    if (typeof req.body[field] === 'boolean') updates[field] = req.body[field];
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from('property_insurance')
    .update(updates)
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

// ─── GET /api/insurance/document/:id ─────────────────────────────────────────
app.get('/api/insurance/document/:id', async (req, res) => {
  const { data: doc, error } = await supabase
    .from('documents')
    .select('file_name, file_path')
    .eq('id', req.params.id)
    .single();

  if (error || !doc) return res.status(404).send('Document not found.');

  const { data: signed, error: signErr } = await supabase.storage
    .from('insurance-documents')
    .createSignedUrl(doc.file_name, 3600);

  if (signErr || !signed) return res.status(500).send('Could not generate download link.');

  res.redirect(signed.signedUrl);
});

// ─── Address helpers ──────────────────────────────────────────────────────────
function normalizeAddress(addr) {
  if (!addr) return '';
  return addr.split(/[,\-]/)[0]
    .toLowerCase()
    .replace(/[.#]/g, '')
    .replace(/\bstreet\b/g,    'st')
    .replace(/\bavenue\b/g,    'ave')
    .replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bdrive\b/g,     'dr')
    .replace(/\broad\b/g,      'rd')
    .replace(/\blane\b/g,      'ln')
    .replace(/\bcourt\b/g,     'ct')
    .replace(/\bplace\b/g,     'pl')
    .replace(/\bcircle\b/g,    'cir')
    .replace(/\bhighway\b/g,   'hwy')
    .replace(/\bnorth\b/g,     'n')
    .replace(/\bsouth\b/g,     's')
    .replace(/\beast\b/g,      'e')
    .replace(/\bwest\b/g,      'w')
    .replace(/\s+/g,           ' ')
    .trim();
}

function addressWordScore(normA, normB) {
  const wa = normA.split(' ').filter(w => w.length > 1);
  const wb = new Set(normB.split(' ').filter(w => w.length > 1));
  if (!wa.length || !wb.size) return 0;
  return wa.filter(w => wb.has(w)).length / Math.max(wa.length, wb.size);
}

function findBestPropertyMatch(extractedAddress, properties) {
  if (!extractedAddress || !properties || !properties.length) return null;
  const normExt = normalizeAddress(extractedAddress);
  if (!normExt) return null;
  let best = null, bestScore = 0;
  for (const prop of properties) {
    const score = addressWordScore(normExt, normalizeAddress(prop.address || ''));
    if (score > bestScore && score >= 0.6) { bestScore = score; best = prop; }
  }
  return best;
}

// ─── Clean filename ────────────────────────────────────────────────────────────
function makeCleanFilename(extracted, ext) {
  const parts = [];
  if (extracted && extracted.property_address)
    parts.push(extracted.property_address.split(',')[0].trim());
  if (extracted && extracted.insurer_name)
    parts.push(extracted.insurer_name);
  if (extracted && extracted.expiration_date)
    parts.push('exp ' + extracted.expiration_date);
  const name = (parts.length ? parts.join(' - ') : 'insurance-document')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return name + (ext || '.pdf');
}

// ─── Storage bucket ────────────────────────────────────────────────────────────
async function ensureStorageBucket() {
  const { error } = await supabase.storage.createBucket('insurance-documents', { public: false });
  // Ignore "already exists" — any other error is logged but non-fatal
  if (error && error.message && !/already exist|duplicate/i.test(error.message)) {
    console.warn('[batch] Storage bucket warn:', error.message);
  }
}

// ─── GET /api/insurance/properties ───────────────────────────────────────────
app.get('/api/insurance/properties', async (req, res) => {
  const { data, error } = await supabase
    .from('properties')
    .select('id, name, address, appfolio_id')
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || []);
});

// ─── POST /api/insurance/batch-upload ────────────────────────────────────────
app.post('/api/insurance/batch-upload', upload.array('files', 50), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }
  const ts = new Date().toISOString();
  console.log(`[${ts}] Batch upload: ${req.files.length} file(s)`);

  const { data: properties } = await supabase
    .from('properties')
    .select('id, name, address, appfolio_id');

  const results = [];

  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    try {
      const fileBuffer   = fs.readFileSync(file.path);
      const fileBase64   = fileBuffer.toString('base64');
      const extractedArr = await extractPolicy(file.path);
      console.log(`[${ts}] Extracted ${extractedArr.length} propert(ies) from ${file.originalname}: ${extractedArr.map(e => e.property_address).join(' | ')}`);

      for (const extracted of extractedArr) {
        // Reject non-California addresses — they're the insurer's office, not the property
        if (extracted.property_address && !/\bCA\b|California/i.test(extracted.property_address)) {
          console.log(`[${ts}] Rejected non-CA address: ${extracted.property_address}`);
          extracted.property_address = null;
        }

        const cleanFilename = makeCleanFilename(extracted, ext);
        const matched = findBestPropertyMatch(
          extracted.property_address,
          properties || []
        );

        let has_existing_policy = false;
        if (matched && matched.appfolio_id) {
          const { data: existing } = await supabase
            .from('property_insurance')
            .select('id')
            .eq('appfolio_property_id', matched.appfolio_id)
            .eq('is_current', true)
            .limit(1);
          has_existing_policy = !!(existing && existing.length > 0);
        }

        results.push({
          original_filename:   file.originalname,
          clean_filename:      cleanFilename,
          file_base64:         fileBase64,
          file_mime_type:      file.mimetype,
          extracted,
          matched_property:    matched
            ? { id: matched.id, appfolio_id: matched.appfolio_id, name: matched.name, address: matched.address }
            : null,
          has_existing_policy,
          error:               null,
        });
      }
    } catch (err) {
      console.error(`[${ts}] Batch extract error (${file.originalname}):`, err.message);
      results.push({
        original_filename:   file.originalname,
        clean_filename:      null,
        file_base64:         null,
        file_mime_type:      null,
        extracted:           null,
        matched_property:    null,
        has_existing_policy: false,
        error:               err.message,
      });
    } finally {
      fs.unlink(file.path, () => {});
    }
  }

  return res.json({ results });
});

// ─── POST /api/insurance/batch-save ──────────────────────────────────────────
app.post('/api/insurance/batch-save', async (req, res) => {
  const ts = new Date().toISOString();
  const records = req.body.records;

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({ error: 'records array is required.' });
  }

  console.log(`[${ts}] Batch save: ${records.length} record(s)`);
  await ensureStorageBucket();

  const MIME_MAP = {
    '.pdf':  'application/pdf',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png':  'image/png',
  };

  let saved = 0;
  const failures = [];
  const outcomes = [];

  for (const record of records) {
    const {
      file_data,
      file_mime_type,
      clean_filename,
      extracted,
      property_id,
      appfolio_property_id,
      additional_insured_verified,
      coverage_amount_verified,
    } = record;

    const label = (extracted && extracted.property_address)
      ? extracted.property_address.split(',')[0].trim()
      : (clean_filename || appfolio_property_id || 'unknown');

    try {
      // Upload to Supabase Storage
      const fileBuffer  = Buffer.from(file_data, 'base64');
      const ext         = path.extname(clean_filename || '').toLowerCase();
      const contentType = file_mime_type || MIME_MAP[ext] || 'application/octet-stream';

      const { error: uploadErr } = await supabase.storage
        .from('insurance-documents')
        .upload(clean_filename, fileBuffer, { contentType, upsert: true });
      if (uploadErr) throw new Error('Storage upload failed: ' + uploadErr.message);

      const { data: urlData } = supabase.storage
        .from('insurance-documents')
        .getPublicUrl(clean_filename);
      const fileUrl = urlData.publicUrl;

      // Flip existing current policy to inactive
      if (appfolio_property_id) {
        await supabase
          .from('property_insurance')
          .update({ is_current: false, updated_at: new Date().toISOString() })
          .eq('appfolio_property_id', appfolio_property_id)
          .eq('is_current', true);
      }

      // Insert document record
      const { data: docRow, error: docErr } = await supabase
        .from('documents')
        .insert({
          file_name:   clean_filename,
          file_path:   fileUrl,
          file_type:   'insurance_certificate',
          mime_type:   contentType,
          entity_type: 'property',
          entity_id:   property_id,
        })
        .select('id')
        .single();
      if (docErr) throw new Error('Document insert failed: ' + docErr.message);

      // Insert new property_insurance record
      const now        = new Date().toISOString();
      const covAmt     = (extracted && extracted.coverage_amount) || null;
      const expDate    = (extracted && extracted.expiration_date) || null;
      const isExpired  = expDate && new Date(expDate) < new Date();
      const belowMin   = covAmt != null && covAmt < 500000;
      const noAddlInsured = !additional_insured_verified;
      const recStatus  = isExpired        ? 'expired'
                       : belowMin         ? 'insufficient_liability'
                       : noAddlInsured    ? 'no_additional_insured'
                       :                    'compliant';

      const { error: insErr } = await supabase.from('property_insurance').insert({
        property_id,
        appfolio_property_id,
        policy_number:               (extracted && extracted.policy_number)    || null,
        insurer_name:                (extracted && extracted.insurer_name)     || null,
        effective_date:              (extracted && extracted.effective_date)   || null,
        expiration_date:             (extracted && extracted.expiration_date)  || null,
        coverage_amount:             covAmt,
        named_insured:               (extracted && extracted.named_insured)    || null,
        property_address_on_policy:  (extracted && extracted.property_address) || null,
        additional_insured_verified: !!additional_insured_verified,
        coverage_amount_verified:    !!coverage_amount_verified,
        status:                      recStatus,
        is_current:                  true,
        document_id:                 docRow.id,
        verified_at:                 now,
        notes:                       belowMin && coverage_amount_verified
          ? `Low liability accepted: $${covAmt.toLocaleString()} (below $500K minimum — manually accepted)`
          : null,
      });
      if (insErr) throw new Error('Insurance insert failed: ' + insErr.message);

      // Audit log
      await supabase.from('audit_log').insert({
        action:      'insurance.batch_saved',
        entity_type: 'property',
        entity_id:   property_id,
        details:     {
          policy_number:   (extracted && extracted.policy_number)   || null,
          expiration_date: (extracted && extracted.expiration_date) || null,
          clean_filename,
        },
      });

      saved++;
      outcomes.push(label + ': saved');
    } catch (err) {
      console.error(`[${ts}] Batch save error (${label}):`, err.message);
      failures.push({ address: label, error: err.message });
      outcomes.push(label + ': error — ' + err.message);
    }
  }

  // One summary task for the whole batch
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + 1);
  const { error: taskErr } = await supabase.from('tasks').insert({
    title:       `Batch insurance import: ${saved} of ${records.length} policies saved`,
    description: outcomes.join('\n'),
    status:      'open',
    priority:    'medium',
    assigned_to: null,
    due_date:    dueDate.toISOString().slice(0, 10),
    entity_type: 'batch_import',
    entity_id:   crypto.randomUUID(),
  });
  if (taskErr) console.warn(`[${ts}] Summary task warn: ${taskErr.message}`);

  console.log(`[${ts}] Batch save complete. Saved: ${saved} / Failed: ${failures.length}`);
  return res.json({
    saved,
    failed: failures.length,
    total:  records.length,
    ...(failures.length > 0 && { errors: failures }),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Insurance server running on port ${PORT}`);
});
