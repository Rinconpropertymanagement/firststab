/**
 * lib/legal-update-scan.js
 * Core logic for the "legal update scan" discovery feed: searches LegiScan
 * for California state bills, keeps ONLY bills that have actually been
 * chaptered (signed into law), and writes survivors into
 * legal_update_candidates (review_status='pending') for Mason/Peter to
 * review. Also logs one row per run to legal_update_scan_runs.
 *
 * THIS MODULE NEVER WRITES TO compliance_claims AND NEVER MAKES A LEGAL
 * FACT. A row here means "a human should look at this," nothing more. See
 * the migration comment in
 * supabase/migrations/20260715000000_legal_update_candidate_scan.sql for
 * the full two-step review rule this schema exists to enforce.
 *
 * No AI/Claude call is used anywhere in this module, on purpose: the
 * "summary" field is built directly from LegiScan's own bill title/
 * description text, never re-interpreted, and topic tagging is a plain
 * keyword-search match, not a judgment call. Compare to lib/viral-scan.js,
 * which does use Claude, but only to judge public interest in a YouTube
 * video — never to state what a law says.
 */

const { listTopics } = require('./compliance');
const { select, insert } = require('./supabase');

// ---------------------------------------------------------------------
// Plain-English labels for compliance_topics.topic_key, used to build
// LegiScan full-text search queries (raw slugs like
// "ab-1482-statewide-and-local-variation" make bad search terms).
//
// Intentionally duplicated from lib/viral-scan.js's TOPIC_LABELS (itself
// duplicated from content-review/server.js's TOPIC_LABELS — search for
// `const TOPIC_LABELS` in that file). Same "small, low-churn, not worth
// shared infrastructure" reasoning as viral-scan.js's copy. If the topic
// list or its labels ever change, update all three places.
// ---------------------------------------------------------------------
const TOPIC_LABELS = {
  'ab-1482-statewide-and-local-variation': 'Rent control / just-cause eviction (AB 1482)',
  'security-deposits': 'Security deposits',
  'rent-increase-rules-and-notice': 'Rent increases & notice requirements',
  'notice-requirements-entry-termination': 'Notice to enter / lease termination',
  'fair-housing': 'Fair housing',
  'trust-account-handling': 'Trust account handling',
  'broker-supervision-pma': 'Broker supervision / property mgmt agreements',
  'general-liability-insurance': 'General liability insurance',
  'lease-agreement-requirements': 'Lease agreement requirements',
  'habitability-and-maintenance': 'Habitability & maintenance',
  'pest-control': 'Pest control',
  'screening-and-application-fees': 'Tenant screening & application fees',
  'eviction-process-and-cost': 'Eviction process & cost',
};

const LEGISCAN_BASE_URL = 'https://api.legiscan.com/';
const STATE = 'CA';

// year=2 means "current" per LegiScan's own getSearchRaw docs (1=all,
// 2=current, 3=recent, 4=prior, >1900=exact). California runs a two-year
// legislative session, so "current" already covers everything chapterable
// right now — no need to widen this for a periodic scan.
const SEARCH_YEAR = 2;

// Search results are already sorted by relevance (highest first) per
// LegiScan's docs. Only the leaders are worth spending a getBill call on —
// same "don't burn API calls on the long tail" reasoning as
// TOP_CANDIDATES_PER_TOPIC in lib/viral-scan.js.
const MAX_RESULTS_PER_TOPIC = 15;

// Hard ceiling on total LegiScan API calls in one run: 12 topic searches +
// up to 12*15=180 getBill calls tops out at 192. 220 leaves headroom while
// still catching a runaway bug if the topic list grows. LegiScan's free
// tier is 30,000 queries/month, so this is nowhere near the real budget —
// this cap exists purely as a sanity backstop, same role
// MAX_YOUTUBE_API_CALLS plays in lib/viral-scan.js.
const MAX_LEGISCAN_API_CALLS = 220;

// LegiScan's numeric status/progress event code for "Chaptered" (signed
// into law). Per the official LegiScan API User Manual (Data Dictionary,
// "Status / Progress" table): values 7-12 (Override, Chaptered, Refer,
// Report Pass, Report DNP, Draft) are explicitly documented as
// "Progress array only" — they NEVER appear in the top-level bill.status
// field, which only ever holds 0-6 (N/A, Introduced, Engrossed, Enrolled,
// Passed, Vetoed, Failed). Verified against a real chaptered bill
// (AB 414, 2025-2026 session): bill.status was 4 ("Passed"), while
// bill.progress contained {"date":"2025-10-06","event":8} and
// bill.history had the literal text "Chaptered by Secretary of State -
// Chapter 340, Statutes of 2025." on that same date. So: checking
// bill.status alone would silently miss every chaptered bill. The correct
// and only reliable signal is an event===8 entry in the progress array.
const CHAPTERED_EVENT_CODE = 8;

function truncate(str, max = 3000) {
  if (!str) return str;
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

// ---------------------------------------------------------------------
// Pure helpers (no I/O) — kept separate so they're easy to unit-test.
// ---------------------------------------------------------------------

/**
 * True only if this bill's progress array contains a Chaptered (event=8)
 * entry. This is the single most important filter in this whole module —
 * see CHAPTERED_EVENT_CODE comment above for why bill.status can't be used.
 */
function isChaptered(bill) {
  return Array.isArray(bill.progress) && bill.progress.some((p) => Number(p.event) === CHAPTERED_EVENT_CODE);
}

/**
 * "AB414" -> "AB 414". LegiScan returns bill numbers with no space; the
 * schema's own comment shows the human convention as "SB 177".
 */
function formatBillNumber(raw) {
  if (!raw) return raw;
  const match = raw.match(/^([A-Za-z]+)\s*(\d+)$/);
  return match ? `${match[1]} ${match[2]}` : raw;
}

/**
 * Build the candidate summary directly from LegiScan's own title +
 * description fields — no AI re-interpretation, per the schema's own rule
 * that this field is a starting point for Mason, not a finished claim.
 */
function buildSummary(bill) {
  const title = (bill.title || '').trim();
  const description = (bill.description || '').trim();
  if (title && description) return truncate(`${title} ${description}`);
  return truncate(title || description || '(No title or description provided by LegiScan.)');
}

// ---------------------------------------------------------------------
// LegiScan API calls
// ---------------------------------------------------------------------

async function legiscanRequest(params, apiKey) {
  const url = new URL(LEGISCAN_BASE_URL);
  url.searchParams.set('key', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LegiScan request failed (${res.status}): ${truncate(body, 300)}`);
  }
  const data = await res.json();
  if (data.status !== 'OK') {
    const message = data.alert?.message || JSON.stringify(data).slice(0, 300);
    throw new Error(`LegiScan API error: ${message}`);
  }
  return data;
}

/**
 * op=getSearchRaw — "appropriate for automated keyword monitoring" per
 * LegiScan's own docs. Returns simplified {bill_id, relevance, change_hash}
 * results only — no status/title/etc, hence the follow-up getBill call per
 * candidate. Results come back sorted by relevance, highest first.
 */
async function legiscanSearchRaw(query, apiKey) {
  const data = await legiscanRequest({ op: 'getSearchRaw', state: STATE, query, year: SEARCH_YEAR }, apiKey);
  const results = data.searchresult?.results;
  if (!results) return [];
  // LegiScan's PHP-originated JSON has, in some historical API versions,
  // serialized "results" as an object keyed by string index ("0","1",...)
  // rather than a plain array. Handle both defensively.
  const list = Array.isArray(results) ? results : Object.values(results);
  return list
    .filter((r) => r && r.bill_id)
    .map((r) => ({ billId: r.bill_id, relevance: Number(r.relevance) || 0 }));
}

/** op=getBill — full bill detail for a given LegiScan-internal bill_id. */
async function legiscanGetBill(billId, apiKey) {
  const data = await legiscanRequest({ op: 'getBill', id: billId }, apiKey);
  return data.bill;
}

// ---------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------

/**
 * Every source_url already surfaced, for exact-match dedup. LegiScan's own
 * bill.url (e.g. "https://legiscan.com/CA/bill/AB414/2025") already encodes
 * state + bill_number + session year, so it's a reliable per-bill,
 * per-session identifier even though the schema has no dedicated LegiScan
 * bill_id column (see migration design notes) — two genuinely different
 * bills, even ones sharing a bill_number across different sessions, can
 * never produce the same URL.
 */
async function getExistingSourceUrls() {
  const rows = await select('legal_update_candidates', 'select=source_url');
  return new Set(rows.map((r) => r.source_url));
}

async function logScanRun({ succeeded, candidatesCreated, errorMessage }) {
  try {
    await insert('legal_update_scan_runs', {
      feed_source: 'legiscan_state_bill_scan',
      succeeded,
      candidates_created: candidatesCreated || 0,
      error_message: errorMessage ? truncate(errorMessage, 1000) : null,
    });
  } catch (err) {
    // Logging the run must never itself take down the script silently —
    // this is the last line of defense, so just surface it loudly.
    console.error(`[scan-legal-updates] Failed to write legal_update_scan_runs row: ${err.message}`);
  }
}

// ---------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------

/**
 * Run one legal-update-scan pass: search LegiScan per compliance topic,
 * fetch detail for every unique bill matched, keep ONLY chaptered bills,
 * dedup against what's already been surfaced, and write survivors into
 * legal_update_candidates.
 *
 * @param {{candidatesCreated: number, topicSearchWarning?: string}} stats -
 *   mutated in place as candidates are created, so the caller can log an
 *   accurate count into legal_update_scan_runs even if this function throws
 *   partway through. topicSearchWarning is set if some (but not all) of the
 *   per-topic LegiScan searches failed, so a "succeeded" run can still carry
 *   a note that part of the search space wasn't actually covered.
 */
async function runLegalUpdateScan(stats = { candidatesCreated: 0 }) {
  const apiKey = process.env.LEGISCAN_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing LEGISCAN_API_KEY. Register for a free key at legiscan.com/legiscan ' +
        'and add it to the root .env as LEGISCAN_API_KEY — same pattern as YOUTUBE_API_KEY.'
    );
  }

  const topics = await listTopics();
  const missingLabels = topics.filter((t) => !TOPIC_LABELS[t.topic_key]);
  if (missingLabels.length > 0) {
    console.warn(
      `[scan-legal-updates] No TOPIC_LABELS entry for: ${missingLabels
        .map((t) => t.topic_key)
        .join(', ')} — using the raw topic_key as the search term.`
    );
  }

  let apiCallCount = 0;
  const canCall = () => apiCallCount < MAX_LEGISCAN_API_CALLS;
  let capHit = false;

  // 1. Search per topic, collecting a dedup'd bill index (a bill can
  // reasonably match more than one topic's search; keep only the
  // highest-relevance topic match per bill for tagging purposes, and only
  // fetch its detail once).
  const billIndex = new Map(); // billId -> { relevance, topicId, topicKey }
  const topicFailures = []; // topic_key of every search that threw
  let lastSearchError = null;

  for (const topic of topics) {
    if (!canCall()) {
      capHit = true;
      break;
    }
    const label = TOPIC_LABELS[topic.topic_key] || topic.topic_key;
    apiCallCount++;
    let results;
    try {
      results = await legiscanSearchRaw(label, apiKey);
    } catch (err) {
      console.warn(`[scan-legal-updates] Search failed for topic "${topic.topic_key}": ${err.message}`);
      topicFailures.push(topic.topic_key);
      lastSearchError = err.message;
      continue;
    }
    for (const r of results.slice(0, MAX_RESULTS_PER_TOPIC)) {
      const existing = billIndex.get(r.billId);
      if (!existing || r.relevance > existing.relevance) {
        billIndex.set(r.billId, { relevance: r.relevance, topicId: topic.id, topicKey: topic.topic_key });
      }
    }
  }

  // If EVERY topic search failed (e.g. an invalid/revoked LEGISCAN_API_KEY),
  // this is not "a quiet week with no new legislation" — it's a broken scan.
  // Returning normally here would let the caller log a false succeeded:true
  // row with candidates_created:0, indistinguishable from a genuine no-op
  // week. Throw so the caller logs a real, visible failure instead.
  if (topics.length > 0 && topicFailures.length === topics.length) {
    throw new Error(
      `All ${topics.length} topic searches failed — check LEGISCAN_API_KEY. ` +
        `Last error: ${lastSearchError}`
    );
  }

  // Some (not all) topic searches failed: the scan is still meaningful, but
  // part of the search space was skipped, so note it for whoever reviews
  // legal_update_scan_runs — a succeeded:true row shouldn't quietly hide
  // partial coverage.
  if (topicFailures.length > 0) {
    stats.topicSearchWarning =
      `${topicFailures.length} of ${topics.length} topic searches failed ` +
      `(${topicFailures.join(', ')}); last error: ${lastSearchError}`;
  }

  if (billIndex.size === 0) {
    if (capHit) {
      console.warn(`[scan-legal-updates] Hit the ${MAX_LEGISCAN_API_CALLS}-call LegiScan API cap during search.`);
    }
    return stats;
  }

  // 2. getBill for every unique candidate, keeping ONLY chaptered bills.
  // This is the critical filter — see isChaptered()/CHAPTERED_EVENT_CODE
  // above for why bill.status can't be used for this check.
  const chapteredBills = []; // { bill, topicId }
  for (const [billId, info] of billIndex) {
    if (!canCall()) {
      capHit = true;
      break;
    }
    apiCallCount++;
    let bill;
    try {
      bill = await legiscanGetBill(billId, apiKey);
    } catch (err) {
      console.warn(`[scan-legal-updates] getBill failed for bill_id ${billId}: ${err.message}`);
      continue;
    }
    if (!bill || !isChaptered(bill)) continue;
    chapteredBills.push({ bill, topicId: info.topicId });
  }

  if (capHit) {
    console.warn(
      `[scan-legal-updates] Hit the ${MAX_LEGISCAN_API_CALLS}-call LegiScan API cap this run — ` +
        'some topics or bill lookups were skipped.'
    );
  }

  if (chapteredBills.length === 0) return stats;

  // 3. Exact-match dedup against legal_update_candidates.source_url — pure
  // lookup, no judgment involved. See getExistingSourceUrls() for why the
  // URL itself is a safe per-bill, per-session dedup key.
  const existingUrls = await getExistingSourceUrls();
  const surviving = chapteredBills.filter(({ bill }) => !existingUrls.has(bill.url));

  if (surviving.length === 0) return stats;

  // 4. Insert. review_status is left unset so it defaults to 'pending' per
  // the schema — this script must NEVER set review_status, resulting_claim_id,
  // or write anywhere draft.js/revise.js could read as a legal fact.
  for (const { bill, topicId } of surviving) {
    await insert('legal_update_candidates', {
      bill_number: formatBillNumber(bill.bill_number),
      jurisdiction: 'California',
      summary: buildSummary(bill),
      status_at_discovery: 'Chaptered',
      effective_date: null, // LegiScan's getBill response has no dedicated effective-date field
      source_url: bill.url,
      topic_id: topicId || null,
    });
    stats.candidatesCreated++;
  }

  return stats;
}

module.exports = {
  TOPIC_LABELS,
  isChaptered,
  formatBillNumber,
  buildSummary,
  getExistingSourceUrls,
  logScanRun,
  runLegalUpdateScan,
};
