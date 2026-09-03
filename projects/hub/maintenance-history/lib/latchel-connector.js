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

// Dedupes a paginated Job list by job_id. Confirmed live (2026-08-28):
// Latchel's /jobs list isn't stably sorted against a live-mutating
// dataset, so a job updated mid-pagination-walk (a ~35-40s, ~155-page
// pull) can shift pages and come back twice in the same pull — one live
// measurement: listJobsUpdatedSince() returned 1,549 raw jobs, only 1,470
// unique job_ids (79 duplicated); property 443904 alone had 9 raw entries
// for 7 unique jobs.
//
// Deliberately NOT done inside getAllPages() itself: that helper is a
// generic, shape-agnostic pager also used for state-history, files, and
// properties responses (getJobStateHistory/getJobFiles/listProperties) —
// none of those response items carry a job_id field (state-history
// entries are timestamp+state only; confirmed live, SPEC.md "Live API
// Verification"). A blind dedupe-by-job_id inside getAllPages() would
// read `undefined` for every item in those other endpoints' results and
// collapse each one down to a single row instead of fixing anything.
// Scoping the dedupe to these two Job-list functions instead fixes it for
// every current caller of Job lists (this file's own listJobsUpdatedSince
// and listJobsNeedingApproval, in turn gather.js, maintenance-history's
// nightly ingest, and approval-briefing's hourly reconcile poll) without
// touching the shared pager's shape-agnostic contract.
function dedupeByJobId(jobs) {
  const seen = new Set();
  const result = [];
  for (const job of jobs) {
    const id = job.job_id;
    if (id != null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    result.push(job);
  }
  return result;
}

/**
 * Jobs updated on/after `isoDate` (YYYY-MM-DD). This is the nightly
 * "what changed since last run" pull — exactly the shape sync.js already
 * uses for AppFolio (SPEC.md "Ingestion Approach" step 1).
 */
async function listJobsUpdatedSince(isoDate) {
  const jobs = await getAllPages(`/jobs?updated_at_start_date=${encodeURIComponent(isoDate)}`);
  return dedupeByJobId(jobs);
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

/**
 * Jobs currently sitting in state 27 ("Needs Approval") — the hourly
 * reconciliation poll's backstop query for the Approval Briefing feature
 * (approval-briefing-SPEC.md Section 3.5). Webhook delivery isn't
 * guaranteed (no retry/backoff documented anywhere in Latchel's docs), so
 * this is the fast path's real safety net, not a fallback-only check.
 */
async function listJobsNeedingApproval() {
  const jobs = await getAllPages('/jobs?in_states=27');
  return dedupeByJobId(jobs);
}

/** Reference data — used only by the periodic property-reconciliation step, not nightly. */
async function listProperties() {
  return getAllPages('/properties');
}

/**
 * Resolves a Job's vendor_id to the real vendor record (name, phone,
 * email) — property-360-SPEC.md "Vendor history." Every real Job carries
 * a vendor_id (confirmed live, 2026-09-02); this is the one place that
 * turns it into an actual name, via GET /vendors/:id. Same latchelGet()
 * helper, same GET-only discipline as every other function in this file
 * — see this file's own header comment. Intended to be called once per
 * job at nightly ingest time, not live on page load (property-360-SPEC.md:
 * "name resolved and stored at nightly ingest, never fetched live").
 */
async function getVendor(vendorId) {
  const body = await latchelGet(`/vendors/${vendorId}`);
  return body.data;
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
  listJobsNeedingApproval,
  listProperties,
  getVendor,
  downloadFile,
};
