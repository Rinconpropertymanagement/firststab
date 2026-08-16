'use strict';

/**
 * lib/b2-client.js
 * Minimal, read-only Backblaze B2 client for the security-deposit tool's
 * photo-folder indexing job (POST /api/security-deposit/internal/index-
 * b2-photos in router.js). Scoped to this tool, not a shared Hub module —
 * same reasoning as the AppFolio connector (lib/appfolio-connector.js):
 * no second consumer of B2 exists anywhere else in this codebase.
 *
 * Uses B2's native REST API directly over fetch() — no SDK dependency,
 * matching sync.js's low-dependency approach to AppFolio.
 *
 * The credential this reads (B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY)
 * must be a READ-ONLY key scoped to the single bucket in B2_BUCKET_NAME
 * (Scotty's setup — see .env.example and SPEC.md's "What Q Needs to
 * Build This"). This module never calls a B2 write or delete endpoint —
 * there is no code path here that could touch a real photo even if the
 * key were accidentally over-scoped.
 *
 * ASSUMPTION FLAGGED FOR VERIFICATION — READ BEFORE RELYING ON THIS:
 * Unlike the AppFolio side of this build, which had a live --discover
 * pass against real data before Neo finalized the schema (see
 * 20260813000000's LIVE DISCOVERY FINDINGS), nobody has yet run an
 * equivalent pass against the real B2 bucket. B2 has no actual folder
 * concept — this uses the standard delimiter="/" common-prefix idiom to
 * fake one, and treats any prefix that directly contains at least one
 * file (not just subfolders) as a "photo folder" worth indexing. That is
 * a reasonable guess at how Rincon's inspection photos are actually
 * organized, not a confirmed fact. TARS/Peter should run this against
 * the real bucket before the indexing cron is trusted end to end, the
 * same way AppFolio's discovery pass happened before Neo built the
 * deposit/multi-tenant schema against it.
 */

const AUTH_URL = 'https://api.backblazeb2.com/b2api/v2/b2_authorize_account';
const MAX_FOLDER_DEPTH = 4; // safety cap on recursive descent — see note above
const AUTH_TTL_MS = 20 * 60 * 60 * 1000; // B2 tokens are valid 24h; refresh well before that

let cachedAuth = null; // { apiUrl, authorizationToken, bucketId, accountId, fetchedAt }

function requireB2Env() {
  const { B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME } = process.env;
  if (!B2_APPLICATION_KEY_ID || !B2_APPLICATION_KEY || !B2_BUCKET_NAME) {
    throw new Error('B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, and B2_BUCKET_NAME must be set in .env.');
  }
  return { B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME };
}

async function authorize() {
  if (cachedAuth && (Date.now() - cachedAuth.fetchedAt) < AUTH_TTL_MS) return cachedAuth;

  const { B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET_NAME } = requireB2Env();
  const credentials = Buffer.from(`${B2_APPLICATION_KEY_ID}:${B2_APPLICATION_KEY}`).toString('base64');

  const res = await fetch(AUTH_URL, { headers: { Authorization: `Basic ${credentials}` } });
  if (!res.ok) {
    throw new Error(`B2 authorization failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = await res.json();

  // A key scoped to a single bucket (as this one must be — read-only,
  // one-bucket, per Scotty's setup) reports that bucket directly in
  // allowed.bucketId, so no separate b2_list_buckets call is needed in
  // the common case.
  let bucketId = body.allowed && body.allowed.bucketId;
  if (!bucketId) {
    bucketId = await lookupBucketId(body.apiUrl, body.authorizationToken, body.accountId, B2_BUCKET_NAME);
  }

  cachedAuth = {
    apiUrl: body.apiUrl,
    authorizationToken: body.authorizationToken,
    accountId: body.accountId,
    bucketId,
    fetchedAt: Date.now(),
  };
  return cachedAuth;
}

async function lookupBucketId(apiUrl, authToken, accountId, bucketName) {
  const res = await fetch(`${apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: authToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, bucketName }),
  });
  if (!res.ok) throw new Error(`B2 list_buckets failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  const bucket = (body.buckets || []).find(b => b.bucketName === bucketName);
  if (!bucket) throw new Error(`B2 bucket "${bucketName}" not found or not accessible with this key.`);
  return bucket.bucketId;
}

// One level of delimiter="/" listing under `prefix`. Returns
// { folders: [...], hasFiles }. B2's own "folder" entries (action:
// 'folder') are the common-prefix idiom; anything else in the page is a
// real file directly under `prefix`.
async function listOneLevel(prefix) {
  const auth = await authorize();
  let startFileName = null;
  const folders = new Set();
  let hasFiles = false;

  do {
    const res = await fetch(`${auth.apiUrl}/b2api/v2/b2_list_file_names`, {
      method: 'POST',
      headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucketId: auth.bucketId,
        prefix,
        delimiter: '/',
        maxFileCount: 1000,
        ...(startFileName ? { startFileName } : {}),
      }),
    });
    if (!res.ok) throw new Error(`B2 list_file_names failed: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();

    for (const file of body.files || []) {
      if (file.action === 'folder') {
        folders.add(file.fileName);
      } else {
        hasFiles = true;
      }
    }
    startFileName = body.nextFileName || null;
  } while (startFileName);

  return { folders: Array.from(folders), hasFiles };
}

// Recursively walks the bucket. Any prefix that directly contains at
// least one file (not just subfolders) is treated as a "photo folder" —
// the unit this tool indexes and sends (as a path string only) to Claude
// for parsing. Capped at MAX_FOLDER_DEPTH as a safety net against an
// unexpectedly deep bucket structure driving up B2 API calls.
async function listPhotoFolders(prefix = '', depth = 0) {
  const results = [];
  const { folders, hasFiles } = await listOneLevel(prefix);

  if (hasFiles && prefix) {
    results.push(prefix.replace(/\/$/, '')); // store without the trailing slash
  }

  if (depth < MAX_FOLDER_DEPTH) {
    for (const folder of folders) {
      const nested = await listPhotoFolders(folder, depth + 1);
      results.push(...nested);
    }
  }

  return results;
}

module.exports = { listPhotoFolders };
