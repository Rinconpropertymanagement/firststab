'use strict';

/**
 * lib/b2-client.js
 * Minimal, read-only Backblaze B2 client for the security-deposit tool.
 * Originally built for the photo-folder indexing job (POST
 * /api/security-deposit/internal/index-b2-photos in router.js —
 * listPhotoFolders()); extended by the targeted-photo-matching addendum
 * (targeted-photo-matching-SPEC.md) with two more functions —
 * listFilesInFolder() and downloadFileBytes() — for general photo
 * browsing and the AI photo-matching call. Scoped to this tool, not a
 * shared Hub module — same reasoning as the AppFolio connector
 * (lib/appfolio-connector.js): no second consumer of B2 exists anywhere
 * else in this codebase.
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
 * DEPLOYMENT DEPENDENCY (flagged for Scotty, targeted-photo-matching-
 * SPEC.md's own Scotty section): downloadFileBytes() below calls B2's
 * b2_download_file_by_name, which needs the `readFiles` capability on
 * this same key — listPhotoFolders()/listOneLevel() above only ever
 * needed `listFiles`. This code assumes `readFiles` has already been
 * added to the existing key (still read-only, still the one bucket, one
 * capability wider than v1 needed) and will fail with a B2-side 401/403
 * on every download call until that capability is actually granted. Not
 * something this module can detect or work around — Scotty's task, not
 * Q's; see this build's handoff notes for the current status.
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

// ─── Basic retry for the recursive bucket walk (Ralph finding) ───────────
// listPhotoFolders() recurses once per B2 "folder" prefix — on a real
// bucket that can be hundreds or thousands of listOneLevel() calls in one
// job. Before this fix, a single transient network blip (a reset, a
// timeout) on any one of those calls threw all the way up through the
// whole recursive walk, and every folder already found in that run — real
// work already done — was discarded with it; the next run started over
// from nothing. Deliberately basic: a couple of attempts with a short
// fixed backoff, not a general retry framework this module doesn't need.
const FETCH_RETRY_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Only retries when fetch() itself rejects — a network-level failure
// (DNS, connection reset, timeout). An actual HTTP error response
// (res.ok === false, e.g. bad auth or a bad request) resolves normally
// and is NOT retried here; callers already handle that case correctly
// via their own `if (!res.ok) throw ...`, and retrying a real rejection
// from B2 would just waste three round trips to fail the same way.
async function fetchWithRetry(url, options) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt < FETCH_RETRY_ATTEMPTS) await sleep(FETCH_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

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
    downloadUrl: body.downloadUrl, // needed by downloadFileBytes() below — distinct from apiUrl (b2_list_file_names etc. use apiUrl; b2_download_file_by_name uses downloadUrl)
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
    const res = await fetchWithRetry(`${auth.apiUrl}/b2api/v2/b2_list_file_names`, {
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

// ─── Targeted photo matching additions (targeted-photo-matching-SPEC.md) ──

// Real image types only — matches detectMediaType()'s own allowed list in
// lib/photo-matcher.js exactly, so nothing can pass this filter that
// photo-matcher would reject or misread anyway. Extension-based (not a
// download-and-sniff check) because this runs at LISTING time, before any
// file's bytes are fetched — the whole point is keeping non-photo files
// out of the candidate pipeline without paying to download them first.
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

function hasImageExtension(fileName) {
  const dot = fileName.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
}

// One PAGE of the individual photo FILES directly inside an already-
// matched B2 folder — not the folder-level listing listPhotoFolders()
// does above. IMPORTANT, unlike listOneLevel() (which internally drains
// every page in a do/while loop before returning, because the indexing
// job above wants everything): this returns ONE page at a time and hands
// the caller B2's own nextFileName cursor to ask for more. Draining a
// whole folder up front here is exactly what general photo browsing must
// NOT do — a folder with hundreds of photos would make the case screen
// wait on the whole folder's file list before showing a single thumbnail.
// listAllFilesInFolder() below (used by the AI-matching route) drains
// this in a loop when it genuinely needs the whole folder's contents.
async function listFilesInFolder(folderPath, options = {}) {
  if (!folderPath || typeof folderPath !== 'string') {
    throw new Error('listFilesInFolder requires a non-empty folder path string.');
  }
  const maxFileCount = Math.min(Math.max(Number(options.maxFileCount) || 60, 1), 1000);
  const auth = await authorize();
  const prefix = folderPath.replace(/\/+$/, '') + '/';

  const res = await fetchWithRetry(`${auth.apiUrl}/b2api/v2/b2_list_file_names`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bucketId: auth.bucketId,
      prefix,
      delimiter: '/', // direct children of this folder only — not nested sub-folders
      maxFileCount,
      ...(options.startFileName ? { startFileName: options.startFileName } : {}),
    }),
  });
  if (!res.ok) throw new Error(`B2 list_file_names failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();

  // BUG FIX (TARS, 2026-08-24, live-bucket test): B2 (and the desktop/
  // sync tools people use to hand-organize a bucket, e.g. Cyberduck)
  // writes a zero-byte ".bzEmpty" placeholder object into a "folder" so
  // an otherwise-empty prefix has something to list — confirmed present
  // in essentially every real folder in this bucket. It is not a photo.
  // Left unfiltered, it sorted first alphabetically (always candidate
  // index 0), passed the MAX_SINGLE_IMAGE_BYTES ceiling trivially (0 <=
  // any max), and was handed to Claude as a zero-byte image, which the
  // API rejects outright — crashing the whole match request with a 500
  // on every real submission, before a single match row could ever be
  // written. Filtered by contentLength === 0 (B2's own byte-size field
  // for a list_file_names entry) rather than only by the ".bzEmpty" name,
  // so any other genuinely empty object is caught too — it would be
  // exactly as useless, and exactly as fatal, as an image candidate.
  //
  // TARS finding (2026-08-24, real bucket): nothing filtered by file
  // TYPE before this — a .mov video file sitting in a move-in folder can
  // sort into the candidate list. It happened to get excluded by the
  // size ceiling in that one real case, but that was luck, not a rule:
  // nothing stopped a small video, or any other non-image file, from
  // reaching Claude as an "image" content block. Filtered here by
  // extension (hasImageExtension, above) for the same reason B2 uploaders
  // don't always send a useful contentType (see detectMediaType's own
  // comment in photo-matcher.js) — the extension is the one signal that's
  // always present and cheap to check at listing time.
  const files = (body.files || [])
    .filter(f => f.action !== 'folder')      // skip B2's common-prefix "folder" entries — files only
    .filter(f => f.contentLength > 0)        // skip .bzEmpty and any other zero-byte object
    .filter(f => hasImageExtension(f.fileName)) // skip .mov and any other non-image file type
    .map(f => ({ fileName: f.fileName.slice(prefix.length), filePath: f.fileName }));

  return { files, nextFileName: body.nextFileName || null };
}

// Safety cap on how many files listAllFilesInFolder() will scan for one
// folder — this is a metadata-only listing (filenames/sizes, no photo
// bytes), so the cost of scanning further is just extra B2 API calls, not
// bandwidth for real photo data. TARS's real folders run ~100 photos;
// this exists so a folder some future edge case dumps thousands of files
// into can't turn one match request into an unbounded listing loop — a
// safety net, not a tuned limit.
const MAX_CANDIDATE_SCAN_FILES = 2000;

// Drains every page of a folder's direct-child image files — the full
// picture listFilesInFolder() deliberately does NOT provide (see its own
// comment: one page at a time, for the lazy-loaded gallery). The AI-match
// route needs the whole folder's file list so it can check EVERY photo in
// it against the submitted move-out photo (Peter's explicit decision,
// 2026-08-25: "build it to check all photos" — this replaced the earlier
// design where router.js sampled only 40 photos evenly across this same
// list). Reuses listFilesInFolder page-by-page so the same folder-
// marker / zero-byte / non-image filtering applies here too, rather than
// duplicating that logic.
async function listAllFilesInFolder(folderPath) {
  const files = [];
  let cursor = null;
  do {
    const page = await listFilesInFolder(folderPath, { maxFileCount: 1000, startFileName: cursor });
    files.push(...page.files);
    cursor = page.nextFileName;
  } while (cursor && files.length < MAX_CANDIDATE_SCAN_FILES);
  // truncated=true only when the safety cap was hit WHILE B2 still had more
  // pages to give (cursor still truthy) — i.e. this folder genuinely has
  // more real photos than the cap scanned. A folder that finishes on its
  // own (cursor goes null) always reports truncated:false, however many
  // files it had. Callers (router.js's photo-matches route) must surface
  // this honestly rather than claiming full coverage when it's true.
  return { files, truncated: !!cursor };
}

// Downloads one file's actual bytes via B2's b2_download_file_by_name.
// Two callers, same function, both discarding the bytes after use —
// neither writes them to disk or to Supabase storage anywhere (Asimov
// condition 2/6, targeted-photo-matching-SPEC.md): (1) the AI matching
// call, which sends the bytes to Claude and then drops the buffer, and
// (2) the photo-file route in router.js, which streams the bytes
// straight through to the browser as the response body. Reusing one
// function for both (rather than a second B2 mechanism like a
// shared/signed download URL, which would need its own `shareFiles`
// capability) keeps this addendum's entire B2 footprint to the one
// already-flagged `readFiles` capability — see the file-header deployment
// note above.
async function downloadFileBytes(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('downloadFileBytes requires a non-empty file path string.');
  }
  const auth = await authorize();
  const { B2_BUCKET_NAME } = requireB2Env();
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const url = `${auth.downloadUrl}/file/${encodeURIComponent(B2_BUCKET_NAME)}/${encodedPath}`;

  const res = await fetchWithRetry(url, { headers: { Authorization: auth.authorizationToken } });
  if (!res.ok) throw new Error(`B2 download failed for "${filePath}": HTTP ${res.status} ${await res.text()}`);

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get('content-type') || null,
    // B2's own content SHA1 doubles as a stable ETag for an immutable
    // object (a photo's bytes at a given path never change in place on a
    // read-only key) — falls back to a real ETag header if B2 ever sends
    // one directly instead.
    etag: res.headers.get('x-bz-content-sha1') || res.headers.get('etag') || null,
    lastModified: res.headers.get('x-bz-upload-timestamp')
      ? new Date(Number(res.headers.get('x-bz-upload-timestamp'))).toUTCString()
      : null,
  };
}

module.exports = { listPhotoFolders, listFilesInFolder, listAllFilesInFolder, downloadFileBytes, MAX_CANDIDATE_SCAN_FILES };
