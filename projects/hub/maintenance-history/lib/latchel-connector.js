/**
 * lib/latchel-connector.js
 * Talks to Rincon's real, live Latchel account (Partner API, real production
 * data — not a sandbox). Scoped locally to this tool, same reasoning
 * security-deposit's appfolio-connector.js gives for not sharing a connector
 * module before a second consumer exists.
 *
 * ============================================================
 * CRITICAL — READ BEFORE ADDING ANYTHING TO THIS FILE
 * ============================================================
 * LATCHEL_API_KEY has full read AND write access to Rincon's real Latchel
 * account. There is no read-only key option (SPEC.md "Latchel API — What's
 * Actually There"). This module is the ONLY place in this codebase that is
 * allowed to call Latchel, and it enforces "read-only in practice" the only
 * way this credential allows: every function below issues a plain GET and
 * NOTHING ELSE. There is no generic "request(method, path)" helper here on
 * purpose — a generic helper would make it one careless call site away from
 * a POST/PUT/PATCH/DELETE against a real account. If a future change needs
 * a new Latchel read, add a new narrowly-named function that calls
 * latchelGet() — never add a way to pass an HTTP method in from outside
 * this file.
 * ============================================================
 */

const LATCHEL_BASE = process.env.LATCHEL_API_BASE || 'https://papi.latchel.com/v1';

function apiKey() {
  const key = process.env.LATCHEL_API_KEY;
  if (!key) throw new Error('LATCHEL_API_KEY is not set. See .env.example.');
  return key;
}

// The one and only place an HTTP request is made to Latchel in this file.
// Always GET. Always this exact call shape.
async function latchelGet(pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : LATCHEL_BASE + pathOrUrl;

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'x-api-key': apiKey() },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new Error(`Latchel rate limit hit (429). Retry-After: ${retryAfter || 'unknown'}.`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Latchel GET ${pathOrUrl} failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Follows links.next until exhausted. Used for every paginated Latchel
// endpoint (jobs: 10/page, state history: 10/page, files: 15/page — real,
// confirmed pagination sizes per SPEC.md "Live API Verification").
//
// Confirmed live against the real account: Latchel's own `links.next` URL
// only ever carries `page` — every other query param from the original
// request (e.g. `updated_at_start_date`) is silently dropped. Following
// `next` as-is meant every page after the first quietly lost the date
// filter and fell back to Latchel's full unfiltered history (verified:
// requesting `/jobs?updated_at_start_date=<30-days-ago>` correctly
// returned only recent jobs on page 1, but its own `next` link,
// `/jobs?page=2`, returned jobs from 2021-2022). Fixed by rebuilding each
// next request from the ORIGINAL url's query params, only taking the page
// number from Latchel's link.
async function getAllPages(path, { maxPages = 200 } = {}) {
  let all = [];
  const originalUrl = new URL(path.startsWith('http') ? path : LATCHEL_BASE + path);
  let next = originalUrl.toString();
  let pages = 0;
  while (next && pages < maxPages) {
    const body = await latchelGet(next);
    all = all.concat(body.data || []);
    const nextLink = body.links && body.links.next;
    if (!nextLink) {
      next = null;
    } else {
      const nextPage = new URL(nextLink).searchParams.get('page');
      const rebuilt = new URL(originalUrl.toString());
      if (nextPage) rebuilt.searchParams.set('page', nextPage);
      next = rebuilt.toString();
    }
    pages++;
  }
  return all;
}

/**
 * Jobs updated on/after `isoDate` (YYYY-MM-DD). This is the nightly
 * "what changed since last run" pull — exactly the shape sync.js already
 * uses for AppFolio (SPEC.md "Ingestion Approach" step 1).
 */
async function listJobsUpdatedSince(isoDate) {
  return getAllPages(`/jobs?updated_at_start_date=${encodeURIComponent(isoDate)}`);
}

/** Full detail for one job — state, dates, budget/estimate, estimate_note. */
async function getJob(jobId) {
  const body = await latchelGet(`/jobs/${jobId}`);
  return body.data;
}

/** State-change timeline: timestamps + state name only (no note text — see SPEC.md). */
async function getJobStateHistory(jobId) {
  return getAllPages(`/jobs/${jobId}/history/state`);
}

/** Attached files (vendor reports, invoices, photos) with time-limited download links. */
async function getJobFiles(jobId) {
  return getAllPages(`/jobs/${jobId}/files`);
}

/** Reference data — used only by the periodic property-reconciliation step, not nightly. */
async function listProperties() {
  return getAllPages('/properties');
}

/**
 * Downloads a file from Latchel's time-limited, pre-signed S3 download
 * link (the `download_link.uri` field on a file object from getJobFiles()).
 * This is still a plain GET — the pre-signed URL carries its own AWS
 * auth in the query string, so no Latchel API key is sent here. The
 * downloaded bytes are only ever held in memory long enough to extract
 * text; SPEC.md is explicit that no file-bytes column exists anywhere in
 * this schema (same restraint as B2 photos) — callers must discard the
 * buffer after extracting text, never persist it.
 */
async function downloadFile(url) {
  // Defense in depth: no credential is sent to this URL today (the
  // pre-signed link carries its own auth), but an http:// (or otherwise
  // unexpected-scheme) link should never be fetched — verify and keep it
  // that way rather than trusting whatever Latchel's API happens to hand
  // back.
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(`Latchel file download link is not a valid URL: ${err.message}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing to download Latchel file from a non-HTTPS URL (scheme was "${parsed.protocol}").`);
  }

  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`Failed to download Latchel file: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  listJobsUpdatedSince,
  getJob,
  getJobStateHistory,
  getJobFiles,
  listProperties,
  downloadFile,
};
