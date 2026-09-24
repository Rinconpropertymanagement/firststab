/**
 * archive-search/router.js
 * Archive Search — built against Neo's schema (supabase/migrations/
 * 20260910030000_archive_search_schema.sql, NOT yet applied — Peter
 * applies it himself via Supabase's SQL Editor) and Oracle's technical
 * spec, projects/hub/email-intake/archive-search-technical-spec.md — read
 * it in full before changing anything here, especially "Resolving the Real
 * Asimov + Mason Review," "The Screening Pass," and "Routes Needed."
 * Product-level design: projects/hub/email-intake/archive-search-v1-
 * scope.md. Companion risk document: compliance/archive-search-ai-risk-
 * assessment.md.
 *
 * Same shape every other Hub tool uses: one router file, an internalRouter
 * for the cron-secret-gated screening pass, mounted into
 * projects/hub/server.js, reusing the Hub's existing login.
 *
 * ============================================================
 * WHAT THIS FILE DOES NOT BUILD (out of scope for THIS pass, per Asimov's
 * own review: "the schema + screening-pass + API build — not Tron's
 * dashboard")
 * ============================================================
 *   - GET /api/archive-search?q=... (the real search-results route) and
 *     GET /api/archive-search/message/:id (the real message-view route).
 *     Both are named in the spec's "Routes Needed" section and both exist
 *     as DESIGNED — this pass deliberately does not build either one. Real
 *     search over raw (if screened) correspondence is exactly the surface
 *     this build's whole validation-sample gate (Finding 5) exists to
 *     clear BEFORE anyone can query it; building the query route ahead of
 *     that gate passing would be building live access ahead of its own
 *     safety check. That route is explicitly deferred, gated behind the
 *     validation sample clearing with zero confirmed misses, and belongs
 *     with Tron's dashboard pass, not this one.
 *   - dashboard/index.html, or any Hub home-page tile. Tron's job, per
 *     CLAUDE.md's agent roster.
 *   - UPDATE, 2026-09-18 (Scotty, per Asimov's split verdict on automatic
 *     scheduling for both AI passes): the screening pass's internal route
 *     (POST /api/archive-search/process-pending) IS now on an automatic
 *     hourly, business-hours-only cron trigger — see that route's own
 *     comment, and cron-archive-search-screening.sh on Sally (not in git,
 *     same as this project's other cron-*.sh wrappers) for the schedule
 *     itself. Cleared specifically because runScreeningPassChunk() now has
 *     a circuit breaker (lib/screening-pass.js) that stops an unattended
 *     chunk early and alerts Peter if its error rate looks unhealthy — see
 *     that route's own comment for the reasoning. The significance/
 *     complaint-triage route (process-significance-pending, Section 7
 *     below) is DELIBERATELY NOT on any automatic schedule yet — see that
 *     route's own comment for why and for the exact steps that turn it on
 *     later. Design Decision 16's original "manually triggered only"
 *     precedent and compliance/archive-search-ai-risk-assessment.md's
 *     posture (line ~67: "moving it onto any kind of schedule is a
 *     separate, later decision requiring its own sign-off") governed BOTH
 *     routes until this change — only the screening pass has since
 *     cleared that separate sign-off.
 *   - Running the screening pass against real data. That is a separate,
 *     later, explicitly-gated step (see screening-pass.js's own header and
 *     the spec's "Before Any of This Runs For Real").
 *   - Any seed/grant row into team_member_tool_roles for tool=
 *     'archive_search'. Who holds 'searcher'/'admin' is Peter's call, made
 *     only after the Finding 5 validation sample passes with zero
 *     confirmed misses (spec, "Access / Roles in the Hub").
 *
 * ============================================================
 * THE FINDING 1 GUARDRAIL — READ BEFORE ADDING ANY NEW QUERY TO THIS FILE
 * ============================================================
 * Every route below queries missive_message_intake_search_safe or
 * missive_message_intake_held_review_safe — the two real, screened VIEWS
 * this schema provides — and NEVER the raw base table by name. The raw
 * table holds this schema's highest-PII-density content, unscreened for
 * privilege/Fair Housing risk; lib/screening-pass.js is the ONE named
 * exception (it must read the base table, by definition, to screen it). A
 * required CI/test check (test/no-raw-table-access-check.js — Asimov's and
 * Mason's technical-spec review, 2026-09-10, promoted this from a
 * recommendation to a hard build requirement) asserts this structurally:
 * run it before changing any query in this file.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { runScreeningPassChunk, getScreeningStatus, fetchFlaggedEarliestBodyTextByConversation, fetchEarliestBodyTextForConversations } = require('./lib/screening-pass');
const { runSignificancePassBatch } = require('./lib/significance-pass');
const { withSignificanceLock, SignificancePassLockedError } = require('./lib/significance-lock');
const { toCsv } = require('./lib/csv');
const { sendMail } = require('../lib/notify');

// ─── Nodemailer — kept ONLY for sendFailureAlertEmail's own independent
// send path (Section 6c below). The escalation notification itself now
// goes through the shared lib/notify.js module instead of this file's own
// copy — see that module's header, and security-deposit/router.js's
// identical comment on its own retained copy, for why
// sendFailureAlertEmail deliberately keeps its own separate one.
let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  console.warn('[archive-search email] nodemailer not installed — escalation notification emails disabled.');
}

// ─── Config ─────────────────────────────────────────────────────────────
const missing = [];
if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[archive-search] Missing environment variables: ${missing.join(', ')}`);
  console.error('[archive-search] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}
// ANTHROPIC_API_KEY and CRON_SECRET are checked lazily where they're
// actually needed (fair-housing-batch-self-report.js's client(), and
// checkCronSecret() below) — same reasoning complaint-tracking/router.js
// gives for its own equivalent keys: a missing key for one route shouldn't
// take down the whole Hub process at startup.

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ─── ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED — same feature-flag shape as
// ARCHIVE_SEARCH_SIGNIFICANCE_CRON_ENABLED (.env.example's own precedent):
// deliberately defaults OFF (unset, empty, or anything other than the
// literal string 'true' means disabled). Gates GET /api/archive-search/
// search reading from archive_search_corpus (supabase/migrations/
// 20260924010000_archive_search_corpus_schema.sql) instead of
// missive_message_intake_search_safe — see that route's own comment for
// the full DEPLOY-ORDER DEPENDENCY this flag exists to make safe rather
// than merely documented: this code can ship with the flag unset and
// change nothing about search's live behavior until Peter has (1) applied
// both 20260924010000 and 20260924020000, (2) run
// run-archive-search-corpus-backfill.js, and (3) TARS has run its
// real-data comparison pass (per Asimov's design confirmation — the one
// thing the shadow-mode waiver does NOT skip). Only then does turning
// this to 'true' actually take effect.
const ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED = process.env.ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED === 'true';

// ============================================================
// SECTION 1: Access — spec, "Access / Roles in the Hub." The exact same
// attach.../require...Access/require...Admin three-function shape every
// other Hub tool implements independently (owner-tenant-notes/router.js's
// own comment on this exact, hard-won "evaluated only against rows where
// tool=<this tool>, never inherited from what 'admin' means on any other
// tool" discipline).
// ============================================================
const ARCHIVE_SEARCH_SEARCH_ROLES = ['searcher', 'admin'];
const ARCHIVE_SEARCH_ADMIN_ROLES = ['admin'];

async function attachArchiveSearchRole(req, res, next) {
  req.archiveSearchRole = null;
  req.teamMemberId = null;
  req.archiveSearchMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members').select('id, full_name, is_active').eq('auth_user_id', req.user.id).maybeSingle();
    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.archiveSearchMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles').select('role')
      .eq('team_member_id', member.id).eq('tool', 'archive_search').maybeSingle();
    if (roleErr) throw roleErr;
    req.archiveSearchRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    console.error('[archive-search] permission lookup failed:', err.message);
    next();
  }
}

// Explicit allow-list, never a bare truthy req.archiveSearchRole — the same
// LeadSimple-precedent discipline every other tool in this codebase now
// follows.
function requireArchiveSearchAccess(req, res, next) {
  if (!ARCHIVE_SEARCH_SEARCH_ROLES.includes(req.archiveSearchRole)) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Archive Search. Ask an admin to grant you access.',
    });
  }
  next();
}

function requireArchiveSearchAdmin(req, res, next) {
  if (!ARCHIVE_SEARCH_ADMIN_ROLES.includes(req.archiveSearchRole)) {
    return res.status(403).json({
      error: 'This action is restricted to Archive Search admins.',
    });
  }
  next();
}

// ============================================================
// SECTION 2: Audit log — sibling implementation, same reasoning every
// other router.js in this codebase gives for its own copy.
// ============================================================
async function lookupUserId(email) {
  const { data } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  return data ? data.id : null;
}

async function writeAuditLog({ action, entity_type, entity_id, actor_email, actor_id, actor_type, risk_level, privacy_category, details }) {
  const performed_by = actor_email ? await lookupUserId(actor_email) : null;
  const { error } = await supabase.from('audit_log').insert({
    action,
    entity_type,
    entity_id,
    performed_by,
    actor_type: actor_type || (actor_email ? 'human' : 'system'),
    actor_id: actor_id || actor_email || 'archive-search',
    privacy_category: privacy_category || 'processing',
    risk_level: risk_level || 'low',
    details: details || {},
  });
  if (error) console.error(`[archive-search] audit_log insert failed for ${action}:`, error.message);
}

// ============================================================
// SECTION 3: Missive deep link.
// Corrected 2026-09-13, second pass: Peter pasted a real, live conversation
// URL from his own browser (https://mail.missiveapp.com/#inbox/
// conversations/<id>) — it's a hash-based route including a mailbox/view
// segment ("inbox"), not a plain /conversations/<id> path as first
// guessed. Using that exact real format. If a link ever 404s again for a
// conversation that's in a different saved view, "inbox" may need to vary
// — not something we have evidence for either way yet.
// ============================================================
function missiveConversationLink(conversationId) {
  return `https://mail.missiveapp.com/#inbox/conversations/${encodeURIComponent(conversationId)}`;
}

// ============================================================
// SECTION 4: Paginated fetch helpers. Supabase/PostgREST caps rows per
// request (and a very large .in() id list risks an oversized query
// string) — both export routes below can touch up to ~1,000 rows, so
// every read here pages through in bounded batches rather than assuming
// one call returns everything.
// ============================================================
const FETCH_PAGE_SIZE = 500;
const IN_BATCH_SIZE = 200;

async function fetchAllPages(buildQuery) {
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + FETCH_PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < FETCH_PAGE_SIZE) break;
    from += FETCH_PAGE_SIZE;
  }
  return all;
}

async function fetchByIdsBatched(table, columns, ids) {
  const uniqueIds = Array.from(new Set(ids));
  let all = [];
  for (let i = 0; i < uniqueIds.length; i += IN_BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + IN_BATCH_SIZE);
    const { data, error } = await supabase.from(table).select(columns).in('id', batch);
    if (error) throw error;
    all = all.concat(data || []);
  }
  return all;
}

// ============================================================
// SECTION 4B: Search-result snippet generation — technical spec, "The
// Search Mechanism": "Snippet generation: computed in application code,
// not ts_headline()... consistent with CLAUDE.md's 'simple is better than
// clever'." Postgres's ts_headline() has no clean pass-through through
// Supabase's query builder without a dedicated RPC function — that would
// be new Postgres-side code (Neo's domain, a schema change Peter has to
// apply), not something this pass adds unasked. This reproduces
// ts_headline()'s familiar default look (a short excerpt, "…" truncation
// markers, the matched term wrapped in <b>...</b>) entirely in JS instead.
// ============================================================
const SNIPPET_WINDOW_BEFORE = 80;
const SNIPPET_WINDOW_AFTER = 120;
const SNIPPET_FALLBACK_LENGTH = 200;

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Pulls plain words out of a websearch-style query string (strips quotes/
// operators — "fair housing" -mold OR leak → ['fair','housing','mold','leak'])
// purely to find something to highlight. Not a real websearch_to_tsquery
// parser — Postgres already applied the real one to determine the match;
// this only decides what to bold in the excerpt shown back.
function extractQueryTerms(query) {
  return (query.match(/[A-Za-z0-9']+/g) || []).filter((t) => t.length > 1);
}

// Finds the first literal occurrence of any query term (checking subject
// first, then body_text, so a subject-only match doesn't show an
// unhighlighted body excerpt instead), and returns a highlighted window
// around it. Falls back to the first SNIPPET_FALLBACK_LENGTH characters of
// body_text, unhighlighted, when no term appears literally — a real,
// possible case: Postgres's 'english' stemming can match a word FORM (e.g.
// a search for "leak" matching stored "leaking") that never appears
// verbatim in the text.
function buildSnippet(subject, bodyText, query) {
  const terms = extractQueryTerms(query);
  const haystacks = [subject || '', bodyText || ''];

  for (const text of haystacks) {
    let matchAt = -1;
    let matchLen = 0;
    for (const term of terms) {
      const idx = text.toLowerCase().indexOf(term.toLowerCase());
      if (idx !== -1 && (matchAt === -1 || idx < matchAt)) {
        matchAt = idx;
        matchLen = term.length;
      }
    }
    if (matchAt !== -1) {
      const start = Math.max(0, matchAt - SNIPPET_WINDOW_BEFORE);
      const end = Math.min(text.length, matchAt + matchLen + SNIPPET_WINDOW_AFTER);
      let excerpt = escapeHtml(text.slice(start, end));
      for (const term of terms) {
        const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        excerpt = excerpt.replace(new RegExp(`(${escapedTerm})`, 'gi'), '<b>$1</b>');
      }
      return (start > 0 ? '…' : '') + excerpt + (end < text.length ? '…' : '');
    }
  }

  const fallback = (bodyText || '').slice(0, SNIPPET_FALLBACK_LENGTH);
  return escapeHtml(fallback) + ((bodyText || '').length > SNIPPET_FALLBACK_LENGTH ? '…' : '');
}

// ============================================================
// SECTION 5: Finding 5 — the validation-sample draw + export.
// ============================================================
const SAMPLE_STRATUM_CUTOFF = '2024-01-01T00:00:00.000Z';
const SAMPLE_SIZE_PER_STRATUM = 500;

function sampleWithoutReplacement(arr, n) {
  const pool = [...arr];
  const result = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    result.push(pool.splice(idx, 1)[0]);
  }
  return result;
}

// Population per Finding 5: every row with screening_result = 'clear'
// after the batch pass — the search-safe view's own definition IS exactly
// that population, so reading it here (rather than the base table) is both
// the required-by-guardrail choice and the spec-correct one.
async function fetchStratumIds(stratum) {
  const buildQuery = () => {
    let q = supabase.from('missive_message_intake_search_safe').select('id').order('id', { ascending: true });
    return stratum === 'A' ? q.gte('delivered_at', SAMPLE_STRATUM_CUTOFF) : q.lt('delivered_at', SAMPLE_STRATUM_CUTOFF);
  };
  const rows = await fetchAllPages(buildQuery);
  return rows.map((r) => r.id);
}

async function currentSampleRun() {
  const { data, error } = await supabase
    .from('archive_search_validation_sample')
    .select('sample_run').order('sample_run', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data ? data.sample_run : 0;
}

// Draws a fresh stratified sample under a NEW sample_run and inserts it.
// Called only when no sample exists yet (first-ever export) or when an
// admin explicitly asks for a re-draw (see the route below) — never
// automatically on a routine re-open, per Finding 5's own "the sample has
// to stay the SAME 1,000 messages across however many times someone
// opens/re-downloads it during review."
async function drawStratifiedSample(nextRun) {
  const [idsA, idsB] = await Promise.all([fetchStratumIds('A'), fetchStratumIds('B')]);
  const drawnA = sampleWithoutReplacement(idsA, SAMPLE_SIZE_PER_STRATUM);
  const drawnB = sampleWithoutReplacement(idsB, SAMPLE_SIZE_PER_STRATUM);

  const insertRows = [
    ...drawnA.map((id) => ({ missive_message_intake_id: id, stratum: 'A', sample_run: nextRun })),
    ...drawnB.map((id) => ({ missive_message_intake_id: id, stratum: 'B', sample_run: nextRun })),
  ];
  if (insertRows.length > 0) {
    const { error } = await supabase.from('archive_search_validation_sample').insert(insertRows);
    if (error) throw error;
  }

  // Not one of the spec's own literally-named events (only .validation_
  // sample_reviewed is named, written once the human review completes) —
  // an additional, small Rule 1 ("every AI/system decision gets logged")
  // write for the draw itself, Q's own judgment call, since drawing which
  // 1,000 specific messages a human will review is itself a real, one-time
  // system action worth a durable record beyond the table rows alone.
  await writeAuditLog({
    action: 'archive_search.validation_sample_drawn',
    entity_type: 'archive_search_validation_sample',
    entity_id: crypto.randomUUID(),
    actor_type: 'system',
    risk_level: 'low',
    privacy_category: 'processing',
    details: { sample_run: nextRun, stratum_a_count: drawnA.length, stratum_b_count: drawnB.length },
  });

  return { stratum_a_count: drawnA.length, stratum_b_count: drawnB.length };
}

// ============================================================
// SECTION 6: Router — everyone reaching here is already Hub-logged-in.
// ============================================================
const router = express.Router();
router.use(attachArchiveSearchRole);

router.get('/api/archive-search/auth/me', requireArchiveSearchAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.archiveSearchMemberName || req.user.email,
    role: req.archiveSearchRole,
  });
});

// ============================================================
// SECTION 5A: The search routes — technical spec, "Routes Needed" and
// "The Search Mechanism." Both query missive_message_intake_search_safe
// only (Finding 1's guardrail, test/no-raw-table-access-check.js) — the
// screened population, never the raw table. No AI call anywhere in either
// route — deterministic Postgres full-text search only, per the product
// doc's explicit "no AI summary" requirement for v1.
// ============================================================
const SEARCH_PAGE_SIZE = 50;

// ─── GET /api/archive-search/search — the search itself.
// requireArchiveSearchAccess (the full searcher+admin population — this is
// the everyday tool, not an admin export). Sorted delivered_at DESC, per
// the product doc's own explicit "newest first, not relevance-ranked"
// decision — not a placeholder pending a future relevance-ranking pass.
// Logs archive_search.query_performed, including the literal query text —
// spec's own deliberate call ("a search query is an act, not archive
// content... 'who searched what' is the entire mechanism by which this
// tool's own use gets audited").
//
// ============================================================
// CORPUS CUTOVER — DEPLOY-ORDER DEPENDENCY, READ BEFORE CHANGING THIS
// ROUTE OR THE ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED FLAG
// ============================================================
// This route can read from either missive_message_intake_search_safe (the
// original, security_barrier'd view — slow/500ing on full-text queries,
// the reason this build exists) or archive_search_corpus (supabase/
// migrations/20260924010000_archive_search_corpus_schema.sql — a separate,
// trigger-maintained, eligible-content-only table with no security_barrier
// to fight the planner). Per projects/hub/email-intake/archive-search-
// search-performance-security-barrier-spec.md and Asimov's CLEARED WITH
// CONDITIONS design confirmation:
//
//   1. archive_search_corpus does not exist until Peter applies
//      20260924010000 AND 20260924020000 (Supabase's SQL Editor, per this
//      project's standing convention — this code never applies a
//      migration itself).
//   2. Even once it exists, it starts EMPTY — it has real content only
//      after Peter runs run-archive-search-corpus-backfill.js.
//   3. Even once backfilled, per Peter's signed shadow-mode waiver
//      (compliance/archive-search-search-performance-security-barrier-
//      shadow-mode-owner-risk-acceptance.md), TARS's real-data comparison
//      pass (sampling actual queries against both tables, confirming
//      identical result sets — the one check that waiver does NOT skip)
//      still needs to run once, for real, before this is relied on.
//
// ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED (defaults to OFF/false, same
// feature-flag shape as ARCHIVE_SEARCH_SIGNIFICANCE_CRON_ENABLED) is the
// explicit, code-level gate for step 3 above — this file can be deployed
// today, with this route's logic already in place, and it changes NOTHING
// about live search behavior (still reads the original
// missive_message_intake_search_safe view, exactly as before) until Peter
// sets that env var to 'true' himself, which he should only do after 1-3
// above are actually done. This is a
// runtime guard, not just a comment: deploying this code before the
// migration/backfill exist can never break search by querying a missing/
// empty table, because the flag defaults to leaving the old behavior in
// place.
//
// Even with the flag on, archive_search_corpus_reconciliation_state's own
// kill_switch_active is checked on every request and falls back to
// missive_message_intake_search_safe automatically — see
// archive_search_corpus_reconcile() (20260924010000) for what sets it.
// ============================================================
router.get('/api/archive-search/search', requireArchiveSearchAccess, async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      return res.status(400).json({ error: 'q is required and cannot be empty.' });
    }

    const pageParam = parseInt(req.query.page, 10);
    const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;
    const offset = (page - 1) * SEARCH_PAGE_SIZE;

    // Default: the original view — unconditionally correct/safe, even if
    // every check below is skipped or fails. searchTable only ever moves
    // to 'archive_search_corpus' after an explicit, successful,
    // just-read-this-request confirmation that it's safe to.
    let searchTable = 'missive_message_intake_search_safe';
    let corpusFallbackReason = ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED ? null : 'flag_disabled';

    if (ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED) {
      try {
        // The kill-switch consult (Section 5/6, 20260924010000) — a plain
        // single-row PK lookup, cheap on every request. Any failure here
        // (table doesn't exist yet, network error, etc.) falls back to the
        // view rather than guessing the corpus is healthy.
        const { data: stateRow, error: stateErr } = await supabase
          .from('archive_search_corpus_reconciliation_state')
          .select('kill_switch_active')
          .eq('id', true)
          .maybeSingle();
        if (stateErr) throw stateErr;
        if (stateRow && stateRow.kill_switch_active) {
          corpusFallbackReason = 'kill_switch_active';
        } else {
          searchTable = 'archive_search_corpus';
        }
      } catch (killSwitchErr) {
        console.error('[archive-search] corpus kill-switch check failed — falling back to missive_message_intake_search_safe for this request:', killSwitchErr.message);
        corpusFallbackReason = 'health_check_failed';
      }
    }

    // Fetch one extra row past the page boundary to answer has_more
    // without a separate COUNT query — same "avoid a second round trip for
    // a yes/no answer" reasoning as the batched-fetch helpers above, applied
    // to search instead. Identical query shape against either table —
    // archive_search_corpus carries the same column set this route already
    // selects (20260924010000's own schema).
    const { data, error } = await supabase
      .from(searchTable)
      .select('id, mailbox_key, missive_conversation_id, subject, from_address, delivered_at, body_text')
      .textSearch('search_document', q, { type: 'websearch', config: 'english' })
      .order('delivered_at', { ascending: false })
      .range(offset, offset + SEARCH_PAGE_SIZE);
    if (error) throw error;

    const rows = data || [];
    const hasMore = rows.length > SEARCH_PAGE_SIZE;
    const pageRows = hasMore ? rows.slice(0, SEARCH_PAGE_SIZE) : rows;

    const results = pageRows.map((r) => ({
      id: r.id,
      missive_conversation_id: r.missive_conversation_id,
      mailbox_key: r.mailbox_key,
      delivered_at: r.delivered_at,
      from_address: r.from_address,
      subject: r.subject,
      snippet: buildSnippet(r.subject, r.body_text, q),
      missive_link: missiveConversationLink(r.missive_conversation_id),
    }));

    await writeAuditLog({
      action: 'archive_search.query_performed',
      entity_type: 'archive_search_query',
      entity_id: crypto.randomUUID(),
      actor_email: req.user.email,
      actor_type: 'human',
      risk_level: 'medium',
      privacy_category: 'processing',
      details: {
        query_text: q,
        page,
        result_count: results.length,
        search_source: searchTable,
        ...(corpusFallbackReason ? { corpus_fallback_reason: corpusFallbackReason } : {}),
      },
    });

    res.json({ query: q, page, page_size: SEARCH_PAGE_SIZE, has_more: hasMore, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/archive-search/message/:id — full message view. Same
// missive_message_intake_search_safe-only restriction — a held or flagged
// message's id simply is not a row in this view, so it 404s exactly like
// any other nonexistent id, never a different response that would leak
// "this id exists but is excluded." A malformed (non-UUID) id gets the
// identical 404, never a 500 — so a bad id can't be told apart from a real
// id that simply isn't in the safe view. Logs archive_search.message_opened.
router.get('/api/archive-search/message/:id', requireArchiveSearchAccess, async (req, res) => {
  try {
    const { data: message, error } = await supabase
      .from('missive_message_intake_search_safe')
      .select('id, mailbox_key, missive_conversation_id, subject, from_address, delivered_at, body_text')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) {
      // Postgres 22P02 = invalid input syntax (a malformed UUID in the
      // URL) — treated the same as "not found."
      if (error.code === '22P02') {
        return res.status(404).json({ error: 'No message found with that id.' });
      }
      throw error;
    }
    if (!message) {
      return res.status(404).json({ error: 'No message found with that id.' });
    }

    await writeAuditLog({
      action: 'archive_search.message_opened',
      // The technical spec's own audit-events table names the bare base
      // table here — deliberately NOT used literally: it would trip the
      // required raw-table-access guardrail (test/no-raw-table-access-
      // check.js), correctly, since this route only ever reads from the
      // safe view (see the query above). Using that exact, already-
      // allowed view name as entity_type is both more accurate and
      // guardrail-clean, with zero special-casing of the guardrail
      // itself needed.
      entity_type: 'missive_message_intake_search_safe',
      entity_id: message.id,
      actor_email: req.user.email,
      actor_type: 'human',
      risk_level: 'medium',
      privacy_category: 'processing',
      details: { missive_conversation_id: message.missive_conversation_id, mailbox_key: message.mailbox_key },
    });

    res.json({
      id: message.id,
      missive_conversation_id: message.missive_conversation_id,
      mailbox_key: message.mailbox_key,
      delivered_at: message.delivered_at,
      from_address: message.from_address,
      subject: message.subject,
      body_text: message.body_text,
      missive_link: missiveConversationLink(message.missive_conversation_id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/archive-search/screening-status — admin-only visibility into
// how much of the backlog is still unscreened, and the real per-outcome
// counts so far. Not named verbatim in the spec's "Routes Needed" list,
// but directly serves the spec's own recommendation ("Build Size and
// Runtime": run a count-only dry run before committing to a live pass, and
// report the real conversation count back to Peter before it's scheduled
// — Open Item 4) and gives a way to watch a chunked run's progress between
// calls to process-pending. Reads only via lib/screening-pass.js's
// getScreeningStatus() — the one file allowed to touch the raw mail table
// directly — never that table by name from this file.
router.get('/api/archive-search/screening-status', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const status = await getScreeningStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/archive-search/validation-sample-export — Finding 5, admin-
// only. Reuses the existing sample_run's draw on a routine open (the SAME
// 1,000 messages every time, per Finding 5's own requirement); draws a
// brand-new run only on the very first call ever (no sample exists yet) or
// when ?redraw=true is explicitly passed. The redraw trigger's exact shape
// is Q's own judgment call — the spec settles WHAT the re-draw rule is
// (Finding 5's exit rule: a confirmed miss forces a full batch-pass re-run
// and a fresh sample before the rule is checked again) but not the literal
// API mechanics of asking for one; a query flag on the one export route
// the spec already names, rather than a second dedicated route, is the
// simplest mechanism that satisfies it (CLAUDE.md: "keep it as simple as
// possible") without adding a route the spec's own "Routes Needed" list
// doesn't include.
router.get('/api/archive-search/validation-sample-export', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const redraw = req.query.redraw === 'true';
    let run = await currentSampleRun();
    if (run === 0 || redraw) {
      run = run + 1;
      await drawStratifiedSample(run);
    }

    const { data: sampleRows, error: sampleErr } = await supabase
      .from('archive_search_validation_sample')
      .select('missive_message_intake_id, stratum')
      .eq('sample_run', run);
    if (sampleErr) throw sampleErr;
    if (!sampleRows || sampleRows.length === 0) {
      return res.status(500).json({ error: 'No validation sample rows found for the current run.' });
    }

    const strataById = new Map(sampleRows.map((r) => [r.missive_message_intake_id, r.stratum]));
    const messages = await fetchByIdsBatched(
      'missive_message_intake_search_safe',
      'id, missive_conversation_id, delivered_at, from_address, subject, body_text',
      sampleRows.map((r) => r.missive_message_intake_id)
    );

    const exportRows = messages.map((m) => ({
      message_id: m.id,
      missive_conversation_id: m.missive_conversation_id,
      stratum: strataById.get(m.id) || '',
      delivered_at: m.delivered_at,
      from_address: m.from_address,
      subject: m.subject,
      body_text: m.body_text,
      missive_link: missiveConversationLink(m.missive_conversation_id),
    }));

    const csv = toCsv(
      ['message_id', 'missive_conversation_id', 'stratum', 'delivered_at', 'from_address', 'subject', 'body_text', 'missive_link'],
      exportRows
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="archive-search-validation-sample-run-${run}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/archive-search/held-review-export — Finding 8, admin-only.
// Mason's Condition 4: Peter/DO/counsel review the held bucket by hand;
// this route only ever exports it, never a disposition/closure workflow.
router.get('/api/archive-search/held-review-export', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const { data: heldRows, error: heldErr } = await supabase
      .from('missive_message_intake_held_review_safe')
      .select('missive_conversation_id, earliest_delivered_at, earliest_subject, earliest_from_address')
      .order('earliest_delivered_at', { ascending: false });
    if (heldErr) throw heldErr;

    // Which mechanism tripped the hold — never the matched term itself —
    // lives only in audit_log.details.hold_mechanism on the
    // archive_search.screening_held event (spec, Finding 8's own "which
    // mechanism tripped the hold" column, and screening-pass.js's own
    // summarizeHoldMechanisms()). One query for every such event, joined
    // in application code — cheap, bounded by the held-conversation count,
    // not the full archive.
    const { data: heldEvents, error: eventsErr } = await supabase
      .from('audit_log').select('details').eq('action', 'archive_search.screening_held');
    if (eventsErr) throw eventsErr;

    const mechanismByConversationId = new Map();
    for (const event of heldEvents || []) {
      const convId = event.details && event.details.source_missive_conversation_id;
      const mechanism = event.details && event.details.hold_mechanism;
      if (convId && !mechanismByConversationId.has(convId)) {
        mechanismByConversationId.set(convId, Array.isArray(mechanism) ? mechanism.join('; ') : (mechanism || ''));
      }
    }

    const exportRows = (heldRows || []).map((r) => ({
      missive_conversation_id: r.missive_conversation_id,
      delivered_at: r.earliest_delivered_at,
      subject: r.earliest_subject,
      from_address: r.earliest_from_address,
      hold_mechanism: mechanismByConversationId.get(r.missive_conversation_id) || '',
      missive_link: missiveConversationLink(r.missive_conversation_id),
    }));

    const csv = toCsv(
      ['missive_conversation_id', 'delivered_at', 'subject', 'from_address', 'hold_mechanism', 'missive_link'],
      exportRows
    );

    await writeAuditLog({
      action: 'archive_search.held_review_export_generated',
      entity_type: 'archive_search_held_export',
      entity_id: crypto.randomUUID(),
      actor_email: req.user.email,
      risk_level: 'low',
      privacy_category: 'processing',
      details: { row_count: exportRows.length },
    });

    // ?format=json — Tron's Legal/Privileged Hold tab (dashboard/
    // compliance-review.html, GET /archive-search/compliance-review below)
    // needs this exact data rendered as an HTML table, and a browser page
    // can't cleanly parse a text/csv attachment response back apart on the
    // client. Identical, already-precedented pattern to flagged-review-
    // export's and escalations-review-export's own ?format=json branches
    // elsewhere in this file: the same exportRows already built above for
    // the CSV, returned as JSON instead — no restructuring, no second
    // query, and the CSV response below (still the default with no query
    // param) is unchanged. This tab is read-only (Finding 8 / Mason's
    // Condition 4 — no override/disposition mechanism exists for held
    // items), so unlike the other two tabs' export rows this one carries no
    // id, no status, and no body_text/snippet field — only what heldRows
    // above actually selects.
    if (req.query.format === 'json') {
      return res.json({ rows: exportRows });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="archive-search-held-review.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SECTION 6b: Flagged-conversation review & reinstatement —
// projects/hub/email-intake/archive-search-flagged-review-spec.md, Section
// 3.3 ("Routes") and Section 4 ("The Required Audit Trail"). Built against
// Neo's migration, supabase/migrations/20260912010000_archive_search_
// flagged_overrides_schema.sql (NOT yet applied — Peter applies it himself).
//
// MASON NOTIFICATION — spec Open Item 1, promoted to a firm requirement by
// Asimov's review: Mason should be told whenever a Fair-Housing flag is
// overridden (or a prior override reversed). No real notification channel
// (email/Slack) exists anywhere in this codebase today, so this cannot be a
// real send yet. Per Asimov's requirement, it is never silently dropped:
// every write below carries an explicit, always-true
// mason_notification_required flag plus a mason_notification_status stating
// no channel exists, so it is visible in the permanent audit_log record
// itself, not just in this comment. See the TODO at each call site.
// ============================================================
function requireNonEmptyReason(value, fieldLabel) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

// ─── GET /api/archive-search/flagged-review-export — spec Section 3.3,
// admin-only. CSV of every currently-flagged conversation (missive_message_
// intake_flagged_review_safe), with body_text for each conversation's
// earliest message fetched via screening-pass.js (the one file allowed to
// read the raw table — see that function's own header for why this route
// can't get body_text any other way), joined in application code against
// archive_search_flagged_overrides (same held-review-export audit_log-join
// pattern) to show existing override AND revocation status per row.
router.get('/api/archive-search/flagged-review-export', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const { data: flaggedRows, error: flaggedErr } = await supabase
      .from('missive_message_intake_flagged_review_safe')
      .select('missive_conversation_id, mailbox_key, earliest_delivered_at, latest_delivered_at, message_count, earliest_subject, earliest_from_address, screening_category, screening_version, screening_completed_at')
      .order('earliest_delivered_at', { ascending: false });
    if (flaggedErr) throw flaggedErr;

    // Every override/revocation row ever written — expected small ("rare,
    // by design," per the migration's own view comment), so one unpaginated-
    // but-still-fetchAllPages-guarded read is fine, same reasoning held-
    // review-export's own audit_log join already uses.
    const overrideRows = await fetchAllPages(() =>
      supabase.from('archive_search_flagged_overrides')
        .select('id, missive_conversation_id, mailbox_key, overridden_screening_completed_at, overridden_by, override_reason, overridden_at, revoked_at, revoked_by, revocation_reason')
    );
    // Keyed on the exact same (conversation, mailbox, completed_at) triple
    // the search-safe view's own EXISTS clause matches on (spec Section
    // 3.1) — so "does this row show an override" here means exactly "is
    // this conversation currently reinstated in search," never a stale,
    // superseded-by-re-screen override from before this determination.
    const overrideByKey = new Map(
      overrideRows.map((o) => [`${o.missive_conversation_id}::${o.mailbox_key}::${o.overridden_screening_completed_at}`, o])
    );

    const bodyTextByKey = await fetchFlaggedEarliestBodyTextByConversation();

    const exportRows = (flaggedRows || []).map((r) => {
      const override = overrideByKey.get(`${r.missive_conversation_id}::${r.mailbox_key}::${r.screening_completed_at}`);
      const body = bodyTextByKey.get(`${r.missive_conversation_id}::${r.mailbox_key}`);
      let override_status = 'not_yet_reviewed';
      if (override) override_status = override.revoked_at ? 'reinstated_then_revoked' : 'reinstated';

      return {
        missive_conversation_id: r.missive_conversation_id,
        mailbox_key: r.mailbox_key,
        message_count: r.message_count,
        earliest_delivered_at: r.earliest_delivered_at,
        latest_delivered_at: r.latest_delivered_at,
        earliest_subject: r.earliest_subject,
        earliest_from_address: r.earliest_from_address,
        screening_category: r.screening_category,
        screening_version: r.screening_version,
        screening_completed_at: r.screening_completed_at,
        body_text: body ? body.body_text : '',
        override_status,
        override_id: override ? override.id : '',
        overridden_by: override ? override.overridden_by : '',
        override_reason: override ? override.override_reason : '',
        overridden_at: override ? override.overridden_at : '',
        revoked_by: override ? override.revoked_by || '' : '',
        revocation_reason: override ? override.revocation_reason || '' : '',
        revoked_at: override ? override.revoked_at || '' : '',
        missive_link: missiveConversationLink(r.missive_conversation_id),
      };
    });

    const csv = toCsv(
      ['missive_conversation_id', 'mailbox_key', 'message_count', 'earliest_delivered_at', 'latest_delivered_at',
        'earliest_subject', 'earliest_from_address', 'screening_category', 'screening_version', 'screening_completed_at',
        'body_text', 'override_status', 'override_id', 'overridden_by', 'override_reason', 'overridden_at',
        'revoked_by', 'revocation_reason', 'revoked_at', 'missive_link'],
      exportRows
    );

    await writeAuditLog({
      action: 'archive_search.flagged_review_export_generated',
      entity_type: 'archive_search_flagged_export',
      entity_id: crypto.randomUUID(),
      actor_email: req.user.email,
      actor_type: 'human',
      risk_level: 'medium',
      privacy_category: 'processing',
      details: { row_count: exportRows.length },
    });

    // ?format=json — Tron's Fair Housing tab (dashboard/compliance-
    // review.html, GET /archive-search/compliance-review below — this
    // tab's page was originally its own standalone dashboard/index.html at
    // GET /archive-search/flagged-review, since merged into the combined
    // page; that old page route now just redirects here) needs this exact
    // data rendered as an HTML table, and a browser page can't cleanly
    // parse a text/csv attachment response back apart on the client.
    // Smallest possible additive change: the same exportRows already built
    // above for the CSV, returned as JSON instead of CSV — no
    // restructuring, no second query, and the CSV response below (still
    // the default with no query param, unchanged in every way) is
    // untouched by this branch.
    if (req.query.format === 'json') {
      return res.json({ rows: exportRows });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="archive-search-flagged-review.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /archive-search/flagged-review — RETIRED as its own page. Tron's
// second pass (space-saving consolidation, Peter's own ask) merged this
// page's entire contents into the "Fair Housing" tab of the new combined
// GET /archive-search/compliance-review page below, verbatim — reinstate,
// bulk-select, quick-pick reasons, sender filter, hide-reviewed toggle, all
// unchanged. Kept alive here as a plain redirect rather than deleted
// outright, purely as a safety net for anyone with this exact URL
// bookmarked (grep across the codebase found no other code path still
// linking here directly — server.js's home-page tile now points straight
// at the combined page) — every route the destination tab actually calls
// is still requireArchiveSearchAdmin-gated on the backend regardless.
router.get('/archive-search/flagged-review', (req, res) => {
  res.redirect(302, '/archive-search/compliance-review?tab=fair-housing');
});

// ─── POST /api/archive-search/flagged/:conversationId/override — spec
// Section 3.3, admin-only. Body: { mailbox_key, reason }, both required.
// Never touches the raw mail-archive base table — only inserts a new row
// into archive_search_flagged_overrides, snapshotting the exact
// determination being overridden (spec Section 3.1).
router.post('/api/archive-search/flagged/:conversationId/override', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    const mailboxKey = typeof req.body.mailbox_key === 'string' ? req.body.mailbox_key.trim() : '';
    const reason = requireNonEmptyReason(req.body.reason);

    if (!mailboxKey) {
      return res.status(400).json({ error: 'mailbox_key is required.' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'reason is required and cannot be empty.' });
    }

    // Step 1 (spec 3.3): read current state from the review-safe view only
    // — never the base table. Filtered by conversationId alone first, then
    // matched against mailboxKey in app code, because a conversation id is
    // only unique WITHIN a mailbox (Section 3.4's named pre-existing
    // ambiguity) — a naive .eq(mailbox_key).maybeSingle() could either miss
    // a real match or throw on an unrelated same-id row in another mailbox.
    const { data: candidateRows, error: lookupErr } = await supabase
      .from('missive_message_intake_flagged_review_safe')
      .select('missive_conversation_id, mailbox_key, screening_category, screening_version, screening_completed_at')
      .eq('missive_conversation_id', conversationId);
    if (lookupErr) throw lookupErr;

    const flaggedRow = (candidateRows || []).find((r) => r.mailbox_key === mailboxKey);
    if (!flaggedRow) {
      return res.status(404).json({ error: 'No currently-flagged conversation found for that conversation id and mailbox.' });
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('archive_search_flagged_overrides')
      .insert({
        missive_conversation_id: flaggedRow.missive_conversation_id,
        mailbox_key: flaggedRow.mailbox_key,
        overridden_screening_category: flaggedRow.screening_category,
        overridden_screening_version: flaggedRow.screening_version,
        overridden_screening_completed_at: flaggedRow.screening_completed_at,
        overridden_by: req.archiveSearchMemberName || req.user.email,
        override_reason: reason,
      })
      .select()
      .single();
    if (insertErr) {
      // Postgres unique_violation — this exact determination was already
      // overridden (e.g. a double submit). Not an error state worth a 500.
      if (insertErr.code === '23505') {
        return res.status(409).json({ error: 'This exact flagged determination has already been overridden.' });
      }
      throw insertErr;
    }

    await writeAuditLog({
      action: 'archive_search.flagged_conversation_overridden',
      entity_type: 'archive_search_flagged_override',
      entity_id: inserted.id,
      actor_email: req.user.email,
      // Hardcoded, never optional, never inferred — spec Section 4's one
      // deliberate non-negotiable value. No code path here can produce
      // this event with actor_type 'system' or 'ai_agent'.
      actor_type: 'human',
      risk_level: 'high',
      privacy_category: 'processing',
      details: {
        override_id: inserted.id,
        missive_conversation_id: inserted.missive_conversation_id,
        mailbox_key: inserted.mailbox_key,
        overridden_screening_category: inserted.overridden_screening_category,
        overridden_screening_version: inserted.overridden_screening_version,
        overridden_screening_completed_at: inserted.overridden_screening_completed_at,
        override_reason: inserted.override_reason,
        // TODO(fast-follow — Asimov's review, spec Open Item 1): no real
        // Mason notification channel (email/Slack) exists in this codebase
        // yet. Build a real send here once one does. Until then, this flag
        // keeps the requirement visible in the permanent audit record
        // rather than silently dropped.
        mason_notification_required: true,
        mason_notification_status: 'not_sent_no_channel_implemented',
      },
    });

    res.json({ ok: true, override: inserted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/archive-search/flagged-override/:overrideId/revoke — NEW,
// Mason's required revocation path. Admin-only. Body: { reason }, required.
// Sets revoked_at/revoked_by/revocation_reason on the existing override
// row — never deletes it, never touches the raw mail-archive base table.
// The moment this commits, missive_message_intake_search_safe's EXISTS
// clause stops matching this row (it requires revoked_at IS NULL), so the
// conversation drops out of search on the very next query, with no
// separate cleanup step.
router.post('/api/archive-search/flagged-override/:overrideId/revoke', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const overrideId = req.params.overrideId;
    const reason = requireNonEmptyReason(req.body.reason);
    if (!reason) {
      return res.status(400).json({ error: 'reason is required and cannot be empty.' });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('archive_search_flagged_overrides')
      .select('id, missive_conversation_id, mailbox_key, overridden_screening_category, overridden_screening_version, overridden_screening_completed_at, revoked_at')
      .eq('id', overrideId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) {
      return res.status(404).json({ error: 'No override found with that id.' });
    }
    if (existing.revoked_at) {
      return res.status(409).json({ error: 'This override has already been revoked.' });
    }

    // .is('revoked_at', null) in the update filter closes the race window
    // between the read above and this write: if two revoke requests land
    // concurrently, only the first actually updates a row; the second gets
    // back zero rows (checked via array length below, not an error code —
    // more robust than depending on a specific PostgREST error shape) and
    // is told, correctly, that it lost the race — never a silent
    // double-revoke or a second, contradictory audit event.
    const { data: updatedRows, error: updateErr } = await supabase
      .from('archive_search_flagged_overrides')
      .update({
        revoked_at: new Date().toISOString(),
        revoked_by: req.archiveSearchMemberName || req.user.email,
        revocation_reason: reason,
      })
      .eq('id', overrideId)
      .is('revoked_at', null)
      .select();
    if (updateErr) throw updateErr;
    if (!updatedRows || updatedRows.length === 0) {
      return res.status(409).json({ error: 'This override has already been revoked.' });
    }
    const updated = updatedRows[0];

    await writeAuditLog({
      action: 'archive_search.flagged_override_revoked',
      entity_type: 'archive_search_flagged_override',
      entity_id: overrideId,
      actor_email: req.user.email,
      // Hardcoded, never optional — identical Section 4 reasoning as the
      // grant event above. No code path here ever revokes automatically.
      actor_type: 'human',
      risk_level: 'high',
      privacy_category: 'processing',
      details: {
        override_id: overrideId,
        missive_conversation_id: updated.missive_conversation_id,
        mailbox_key: updated.mailbox_key,
        overridden_screening_category: updated.overridden_screening_category,
        overridden_screening_version: updated.overridden_screening_version,
        overridden_screening_completed_at: updated.overridden_screening_completed_at,
        revocation_reason: updated.revocation_reason,
        // Same TODO as the grant event's identical field, and the same
        // fast-follow requirement — Q's own extension, not literally named
        // in Open Item 1, made for consistency: reversing search access to
        // Fair-Housing-adjacent content is at least as worth Mason knowing
        // about as granting it (spec Section 4's own "matching, not
        // exceeding" risk_level reasoning for this event). Flagged here so
        // Peter/Asimov/Mason can confirm or narrow this scope.
        mason_notification_required: true,
        mason_notification_status: 'not_sent_no_channel_implemented',
      },
    });

    res.json({ ok: true, override: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SECTION 6c: Employee escalation mechanism for material Fair Housing
// concerns — projects/hub/email-intake/archive-search-escalation-
// mechanism-spec.md, Section 3.3 ("Routes") and Section 5
// ("Notification"). Built against Neo's migration, supabase/migrations/
// 20260912030000_archive_search_escalations_schema.sql.
//
// LIVE-VERIFIED, 2026-09-12 (Q): as of this build, the archive_search_
// escalations table does NOT yet exist against the real Supabase
// project — confirmed directly (a plain SELECT against it returns
// PostgREST PGRST205, "Could not find the table... in the schema
// cache"). The same is true of archive_search_flagged_overrides and its
// own review-safe view (Section 6b's own dependencies). Every route
// below will 500/404 until Peter applies that migration himself via
// Supabase's SQL Editor, per this project's standing convention — Q
// does not run DDL against production. Not a bug in this file; flagged
// here so it isn't mistaken for one.
//
// Distinct from Section 6b above: that mechanism corrects a
// false-positive AI flag; this one records the opposite-direction fact —
// a human proactively reporting a concern the AI check did not catch.
//
// NOTIFICATION — spec Section 5 and "Decisions Recorded" (Peter,
// 2026-09-12): unlike Section 6b's flagged-conversation override (which
// has no real notification channel and carries an explicit
// mason_notification_required/_status placeholder), a real, already-
// wired email channel exists in this codebase (now ../lib/notify.js,
// shared with security-deposit/router.js and insurance/router.js — see
// that module's header), and Peter decided the escalation email goes to
// BOTH DO_EMAIL and PETER_EMAIL — not a choice between them. See .env.example
// for both variables; both are optional and the mailer degrades
// gracefully (never throws, always reports success/failure honestly)
// if either or both are unset, same posture every other email-sending
// route in this codebase already has.
// ============================================================

function createMailer() {
  if (!nodemailer || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

// ─── Escalation notification email — spec Section 5. Sent to every
// configured address in [DO_EMAIL, PETER_EMAIL] (both, per Peter's own
// decision — see the section header above), the moment a concern is
// reported. Returns true ONLY when the email actually went out — same
// honesty discipline security-deposit/router.js's sendEscalationEmail()
// already established for this exact class of notification (never
// folded into an overall success:true if it's actually false). The
// escalate route below reports this result both in the audit_log entry
// (spec Section 4's own JSON schema for archive_search.escalation_reported
// names notification_email_sent as a field) and in the API response, and
// fires sendFailureAlertEmail() when it's false.
async function sendEscalationEmail(escalation, reportedByName) {
  // Both addresses independently, per Peter's own recorded decision — not
  // a choice between them. Left as env-var reads here (not migrated to
  // shared_inboxes / a person lookup) per this build's task scope.
  const recipients = [process.env.DO_EMAIL, process.env.PETER_EMAIL].filter(Boolean);
  if (!recipients.length) {
    console.error('[archive-search email] Escalation reported but no recipient configured — DO_EMAIL and PETER_EMAIL are both unset.');
    return false;
  }

  const result = await sendMail({
    to: recipients,
    subject: 'Archive Search: Fair Housing concern reported — needs your review',
    text: [
      'A Rincon Hub user has reported a suspected material Fair Housing concern found while using Archive Search.',
      '',
      `Reported by:    ${reportedByName}`,
      `Reported at:    ${escalation.reported_at}`,
      `Reason given:   ${escalation.escalation_reason}`,
      '',
      `Conversation:   ${missiveConversationLink(escalation.missive_conversation_id)}`,
      '',
      'This conversation has already been removed from Archive Search for everyone, effective immediately — this email is so it gets reviewed, not to gate that removal.',
      'Log in to the Rincon Hub, open Archive Search, and pull the escalations review export to see the full record (including the correspondence itself) and resolve it as confirmed or false alarm.',
    ].join('\n'),
  });
  if (!result.ok) {
    const detail = result.error || `${result.rejected.length} of ${recipients.length} recipient(s) rejected: ${result.rejected.join(', ')}`;
    console.error(`[archive-search email] Escalation notification failed: ${detail}`);
    return false;
  }
  console.log(`[archive-search email] Escalation notification sent to ${recipients.length} recipient(s).`);
  return true;
}

// ─── Failure alert — same shape/purpose as security-deposit/router.js's
// sendFailureAlertEmail(): if the primary notification silently fails, a
// mail-server-level outage shouldn't also silence the alert that it
// failed. Sent to a hardcoded literal, exactly like security-deposit's
// own FAILURE_ALERT_RECIPIENT — deliberately NOT read from PETER_EMAIL,
// so a typo'd or unset PETER_EMAIL can't also take out this alert
// channel (the one thing this route needs to still work when the
// primary notification's own recipient config is what's broken).
const FAILURE_ALERT_RECIPIENT = 'peter@rinconmanagement.com';
async function sendFailureAlertEmail(subject, body) {
  try {
    const mailer = createMailer();
    if (!mailer) {
      console.error(`[HUB-ALERT] Could not send failure alert — mailer unavailable (GMAIL_USER/GMAIL_APP_PASSWORD not configured). Subject would have been: ${subject}`);
      return false;
    }
    await mailer.sendMail({
      from: process.env.GMAIL_USER,
      to: FAILURE_ALERT_RECIPIENT,
      subject: `[ALERT] ${subject}`,
      text: body,
    });
    console.error(`[HUB-ALERT] Failure alert sent to ${FAILURE_ALERT_RECIPIENT}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[HUB-ALERT] Failure alert itself failed to send: ${err.message} — original subject: ${subject}`);
    return false;
  }
}

// ─── POST /api/archive-search/escalate — spec Section 3.3. The full
// 'searcher'+'admin' population, per spec Section 1 — a deliberate
// departure from Section 6b's admin-only override, because counsel's own
// opinion says "the employee" (not "the admin") should escalate.
// Body: { missive_conversation_id, mailbox_key, reason }, all required.
router.post('/api/archive-search/escalate', requireArchiveSearchAccess, async (req, res) => {
  try {
    const missiveConversationId = typeof req.body.missive_conversation_id === 'string' ? req.body.missive_conversation_id.trim() : '';
    const mailboxKey = typeof req.body.mailbox_key === 'string' ? req.body.mailbox_key.trim() : '';
    const reason = requireNonEmptyReason(req.body.reason);

    if (!missiveConversationId) {
      return res.status(400).json({ error: 'missive_conversation_id is required.' });
    }
    if (!mailboxKey) {
      return res.status(400).json({ error: 'mailbox_key is required.' });
    }
    if (!reason) {
      return res.status(400).json({ error: 'reason is required and cannot be empty.' });
    }

    // Step 0 (fix — compliance/archive-search-escalation-mechanism-
    // review.md, Outstanding Items #3, second finding): check
    // archive_search_escalations DIRECTLY, before the general
    // searchability check below, for an existing 'open' escalation, or a
    // 'confirmed' escalation that has NOT been reopened, on this exact
    // (missive_conversation_id, mailbox_key) pair. Previously, a second
    // report on an already-reported conversation fell straight into the
    // searchability check's generic 404 below ("may already be held,
    // flagged, or already reported") — Mason's own review flagged that a
    // second reporter reading that response could reasonably conclude the
    // conversation doesn't exist, rather than that someone already
    // reported it. This runs first and, when it finds a still-effective
    // escalation, returns a specific 409 naming who reported it, when,
    // and its current status — never the correspondence itself, only this
    // escalation's own metadata (reporter, date, status), same CSV-safe/
    // audit-safe restraint the export routes already apply. A 'confirmed'
    // escalation that HAS been reopened does not count as still-effective
    // here — the conversation is searchable again, so a fresh report on
    // it is a genuinely new report, not a duplicate, and falls through to
    // the searchability check below like any other conversation.
    //
    // DEPLOY-ORDER DEPENDENCY, flagged plainly because this route is
    // already live in production, unlike the rest of this section when it
    // first shipped: the SELECT below names reopened_at, a column that
    // only exists once supabase/migrations/20260912040000_add_reopen_to_
    // archive_search_escalations.sql is applied. That migration MUST be
    // applied before this updated router.js is deployed — otherwise every
    // call to this already-working route (not just duplicate reports)
    // starts failing with a 500 (column does not exist), which is a real
    // regression, not just an inert new feature waiting on its own schema.
    const { data: candidateEscalations, error: escalationLookupErr } = await supabase
      .from('archive_search_escalations')
      .select('reported_by, reported_at, status, reopened_at')
      .eq('missive_conversation_id', missiveConversationId)
      .eq('mailbox_key', mailboxKey)
      .in('status', ['open', 'confirmed'])
      .order('reported_at', { ascending: false });
    if (escalationLookupErr) throw escalationLookupErr;
    const stillEffective = (candidateEscalations || []).find((r) => r.status === 'open' || !r.reopened_at);
    if (stillEffective) {
      const reportedDate = new Date(stillEffective.reported_at).toISOString().slice(0, 10);
      const message = stillEffective.status === 'open'
        ? `This conversation was already reported on ${reportedDate} by ${stillEffective.reported_by} and is under review.`
        : `This conversation was already reported on ${reportedDate} by ${stillEffective.reported_by} and was confirmed as a real concern — it remains excluded from search.`;
      return res.status(409).json({ error: message });
    }

    // Step 1 (spec 3.3): confirm this conversation is currently visible via
    // missive_message_intake_search_safe — never the base table — before
    // accepting a report on it. Same "fetch by conversation id, match
    // mailbox in application code" pattern the flagged-override route
    // above already uses, for the identical reason: a conversation id is
    // only unique WITHIN a mailbox. By this point Step 0 has already ruled
    // out "already reported" as the reason a conversation might not be
    // searchable, so this generic message now correctly means what it
    // says — held or flagged-without-override, not already-escalated.
    const { data: candidateRows, error: lookupErr } = await supabase
      .from('missive_message_intake_search_safe')
      .select('missive_conversation_id, mailbox_key')
      .eq('missive_conversation_id', missiveConversationId);
    if (lookupErr) throw lookupErr;
    const isCurrentlySearchable = (candidateRows || []).some((r) => r.mailbox_key === mailboxKey);
    if (!isCurrentlySearchable) {
      return res.status(404).json({ error: 'No currently-searchable conversation found for that conversation id and mailbox — it may already be held or flagged.' });
    }

    const reportedBy = req.archiveSearchMemberName || req.user.email;
    const { data: inserted, error: insertErr } = await supabase
      .from('archive_search_escalations')
      .insert({
        missive_conversation_id: missiveConversationId,
        mailbox_key: mailboxKey,
        reported_by: reportedBy,
        escalation_reason: reason,
      })
      .select()
      .single();
    if (insertErr) {
      // Postgres unique_violation — the partial index (one open report per
      // conversation) means this exact conversation already has an open
      // report on file. Not an error state worth a 500 — same handling the
      // flagged-override route above already uses for its own comparable
      // unique-violation case.
      if (insertErr.code === '23505') {
        return res.status(409).json({ error: 'This conversation already has an open Fair Housing concern report.' });
      }
      throw insertErr;
    }

    // Send the notification email BEFORE writing the audit log. This is a
    // deliberate reordering of the spec's own numbered steps (3.3 lists
    // "write the log" as step 4, "send the email" as step 5) — necessary
    // to honestly satisfy the spec's OWN Section 4 details schema for this
    // exact event, which requires notification_email_sent to be a real
    // field INSIDE the log entry, not just in the API response. The
    // report itself is already durably saved (the insert above already
    // committed) before either the email or the log write is attempted,
    // so this reordering never risks losing the report if either one
    // fails.
    const notificationSent = await sendEscalationEmail(inserted, reportedBy);
    if (!notificationSent) {
      await sendFailureAlertEmail(
        'Archive Search: escalation notification email failed to send',
        `A Fair Housing concern was reported (escalation id ${inserted.id}, conversation ${missiveConversationId}, mailbox ${mailboxKey}) by ${reportedBy}, but the notification email to DO_EMAIL/PETER_EMAIL did not send. The report itself was saved — this is only the email notification.\n\nReason given: ${reason}\n\nCheck the server logs and GMAIL_USER/GMAIL_APP_PASSWORD/DO_EMAIL/PETER_EMAIL.`
      );
    }

    await writeAuditLog({
      action: 'archive_search.escalation_reported',
      entity_type: 'archive_search_escalation',
      entity_id: inserted.id,
      actor_email: req.user.email,
      // Hardcoded, never optional, never inferred — spec Section 4's one
      // deliberate non-negotiable value. No code path here can produce
      // this event with actor_type 'system' or 'ai_agent'.
      actor_type: 'human',
      risk_level: 'high',
      privacy_category: 'processing',
      details: {
        escalation_id: inserted.id,
        missive_conversation_id: inserted.missive_conversation_id,
        mailbox_key: inserted.mailbox_key,
        reported_by: inserted.reported_by,
        escalation_reason: inserted.escalation_reason,
        notification_email_sent: notificationSent,
      },
    });

    res.json({ ok: true, escalation: inserted, notification_email_sent: notificationSent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/archive-search/escalations-review-export — spec Section
// 3.3, admin-only. CSV of every row in archive_search_escalations,
// ordered by reported_at DESC, with body_text for each conversation's
// earliest message (fetched via screening-pass.js's
// fetchEarliestBodyTextForConversations() — the one file allowed to
// read the raw table — never queried directly from here) and a Missive
// deep link, so the reviewer can judge the real content, same "the
// reviewer needs the real content to judge it" reasoning
// flagged-review-export/validation-sample-export already establish.
//
// Tron's addition (escalations-review admin page build): the `id`
// column and the four reopen columns (reopened_at/reopened_by/
// reopen_reason/litigation_hold_attestation — supabase/migrations/
// 20260912050000_reconcile_20260912040000_timestamp_collision.sql,
// confirmed live) are now selected and included in exportRows/the CSV.
// Neither was needed for a CSV a human reads by eye, but both are a hard
// requirement for an admin PAGE built on top of this same export: `id`
// is the only way to call POST .../escalations/:id/resolve or /reopen
// against a specific row at all, and reopened_at/_by are the only way
// the page can tell "confirmed, still excluded" apart from "confirmed,
// then reopened" without a second round-trip. Purely additive — no
// existing column removed, no filter/ordering/access-check changed, same
// discipline every other additive column in this file's export routes
// already follows (e.g. flagged-review-export's own override_id).
router.get('/api/archive-search/escalations-review-export', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const escalationRows = await fetchAllPages(() =>
      supabase.from('archive_search_escalations')
        .select('id, missive_conversation_id, mailbox_key, reported_by, reported_at, escalation_reason, status, resolved_by, resolved_at, resolution_notes, reopened_at, reopened_by, reopen_reason, litigation_hold_attestation')
        .order('reported_at', { ascending: false })
    );

    const bodyTextByKey = await fetchEarliestBodyTextForConversations(
      escalationRows.map((r) => ({ missive_conversation_id: r.missive_conversation_id, mailbox_key: r.mailbox_key }))
    );

    const exportRows = escalationRows.map((r) => {
      const body = bodyTextByKey.get(`${r.missive_conversation_id}::${r.mailbox_key}`);
      return {
        id: r.id,
        reported_at: r.reported_at,
        reported_by: r.reported_by,
        escalation_reason: r.escalation_reason,
        missive_conversation_id: r.missive_conversation_id,
        mailbox_key: r.mailbox_key,
        status: r.status,
        resolved_by: r.resolved_by || '',
        resolved_at: r.resolved_at || '',
        resolution_notes: r.resolution_notes || '',
        reopened_at: r.reopened_at || '',
        reopened_by: r.reopened_by || '',
        reopen_reason: r.reopen_reason || '',
        litigation_hold_attestation: r.litigation_hold_attestation || '',
        body_text: body ? body.body_text : '',
        missive_link: missiveConversationLink(r.missive_conversation_id),
      };
    });

    // Column order matters here, not just presence: this is the default,
    // no-query-param CSV response, and it existed with real column
    // positions (archive-search-escalation-mechanism-spec.md's own
    // Section 3.3 listing) before `id` and the four reopen fields were
    // added below. TARS caught that an earlier version of this change
    // inserted them mid-list, silently reordering every column after
    // `resolution_notes` for anyone already relying on CSV column
    // position. Fixed by appending all five new fields after the
    // original, unchanged column order instead of interleaving them.
    const csv = toCsv(
      ['reported_at', 'reported_by', 'escalation_reason', 'missive_conversation_id', 'mailbox_key', 'status',
        'resolved_by', 'resolved_at', 'resolution_notes', 'body_text', 'missive_link',
        'id', 'reopened_at', 'reopened_by', 'reopen_reason', 'litigation_hold_attestation'],
      exportRows
    );

    await writeAuditLog({
      action: 'archive_search.escalation_review_export_generated',
      entity_type: 'archive_search_escalation_export',
      entity_id: crypto.randomUUID(),
      actor_email: req.user.email,
      actor_type: 'human',
      risk_level: 'medium',
      privacy_category: 'processing',
      details: { row_count: exportRows.length },
    });

    // ?format=json — Tron's Escalations tab (dashboard/compliance-
    // review.html, GET /archive-search/compliance-review below — this
    // tab's page was originally its own standalone dashboard/escalations-
    // review.html at GET /archive-search/escalations-review, since merged
    // into the combined page; that old page route now just redirects
    // here) needs this exact data rendered as an HTML table, and a browser
    // page can't cleanly parse a text/csv attachment response back apart
    // on the client. Identical, already-precedented pattern to flagged-
    // review-export's own ?format=json branch just above in this file:
    // same exportRows already built for the CSV, returned as JSON instead
    // — no restructuring, no second query, and the CSV response below
    // (still the default with no query param) is unchanged.
    if (req.query.format === 'json') {
      return res.json({ rows: exportRows });
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="archive-search-escalations-review.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /archive-search/escalations-review — RETIRED as its own page,
// same reasoning and same treatment as GET /archive-search/flagged-review
// just above: its entire contents (resolve/reopen flows, unchanged) now
// live in the "Escalations" tab of GET /archive-search/compliance-review
// below. Kept alive as a plain redirect, not deleted, for the identical
// bookmarked-URL safety-net reason.
router.get('/archive-search/escalations-review', (req, res) => {
  res.redirect(302, '/archive-search/compliance-review?tab=escalations');
});

// ─── GET /archive-search/compliance-review — Tron's second pass, replacing
// the two separate admin pages above with one tabbed page (Peter's own ask:
// save space on the Hub home page — one tile instead of two). Three tabs,
// pure client-side switching (no page reload):
//   - Fair Housing: the old GET /archive-search/flagged-review page,
//     moved here as-is.
//   - Escalations: the old GET /archive-search/escalations-review page,
//     moved here as-is.
//   - Legal/Privileged Hold: NEW. Read-only display of GET /api/archive-
//     search/held-review-export?format=json (added above, same precedent
//     as the other two export routes' own ?format=json branch). Read-only
//     because no override/disposition mechanism exists for held items —
//     Finding 8 / Mason's Condition 4: a human reviews the held bucket by
//     hand outside this tool; this tab only ever displays it.
// Same page-shell pattern as the two pages it replaces: no data embedded
// server-side, a single shared GET /api/archive-search/auth/me check run
// once at page load (not once per tab — the three tabs share one identical
// admin gate, so checking three times would just be three redundant
// network calls for the same answer), and each tab's own export route
// fetched lazily on that tab's first view, not all three up front. Every
// route any tab calls remains requireArchiveSearchAdmin-gated on the
// backend regardless of what the frontend shows.
router.get('/archive-search/compliance-review', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'compliance-review.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html);
  });
});

// ─── POST /api/archive-search/escalations/:id/resolve — spec Section
// 3.3, admin-only. Body: { resolution, resolution_notes }; resolution
// must be 'confirmed' or 'false_alarm', both fields required. Sets
// status/resolved_by/resolved_at/resolution_notes together on the
// existing row — never deletes it, never touches the raw mail-archive
// base table. The moment 'false_alarm' commits, the conversation
// reappears in missive_message_intake_search_safe on the very next
// query (its NOT EXISTS clause stops matching); 'confirmed' leaves the
// exclusion in place, permanently, by design.
router.post('/api/archive-search/escalations/:id/resolve', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const escalationId = req.params.id;
    const resolution = req.body.resolution;
    const notes = requireNonEmptyReason(req.body.resolution_notes);

    if (resolution !== 'confirmed' && resolution !== 'false_alarm') {
      return res.status(400).json({ error: "resolution is required and must be 'confirmed' or 'false_alarm'." });
    }
    if (!notes) {
      return res.status(400).json({ error: 'resolution_notes is required and cannot be empty.' });
    }

    const { data: existing, error: fetchErr } = await supabase
      .from('archive_search_escalations')
      .select('id, missive_conversation_id, mailbox_key, status')
      .eq('id', escalationId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) {
      return res.status(404).json({ error: 'No escalation found with that id.' });
    }
    if (existing.status !== 'open') {
      return res.status(409).json({ error: 'This escalation has already been resolved.' });
    }

    // .eq('status', 'open') in the update filter closes the same
    // concurrent-request race window flagged-override/:overrideId/revoke
    // already closes for its own update: if two resolve requests land
    // concurrently, only the first actually updates a row; the second gets
    // back zero rows and is told, correctly, that it lost the race —
    // never a silent double-resolution or two contradictory audit events.
    const { data: updatedRows, error: updateErr } = await supabase
      .from('archive_search_escalations')
      .update({
        status: resolution,
        resolved_by: req.archiveSearchMemberName || req.user.email,
        resolved_at: new Date().toISOString(),
        resolution_notes: notes,
      })
      .eq('id', escalationId)
      .eq('status', 'open')
      .select();
    if (updateErr) throw updateErr;
    if (!updatedRows || updatedRows.length === 0) {
      return res.status(409).json({ error: 'This escalation has already been resolved.' });
    }
    const updated = updatedRows[0];

    await writeAuditLog({
      action: 'archive_search.escalation_resolved',
      entity_type: 'archive_search_escalation',
      entity_id: escalationId,
      actor_email: req.user.email,
      // Hardcoded, never optional — identical Section 4 reasoning as the
      // report event above. No code path here ever resolves automatically.
      actor_type: 'human',
      risk_level: 'high',
      privacy_category: 'processing',
      details: {
        escalation_id: escalationId,
        missive_conversation_id: updated.missive_conversation_id,
        mailbox_key: updated.mailbox_key,
        resolution: updated.status,
        resolution_notes: updated.resolution_notes,
      },
    });

    res.json({ ok: true, escalation: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/archive-search/escalations/:id/reopen — Peter's own
// decision, 2026-09-12 (compliance/archive-search-escalation-mechanism-
// review.md, Outstanding Items #3, resolved): a 'confirmed' escalation
// should be reversible — a human can later decide the original
// confirmation was wrong and restore search access — WITHOUT ever
// erasing the fact that it was once confirmed, by whom, when, and why.
//
// A SEPARATE route from resolve above, not resolve extended to accept a
// third value — same reasoning this file already applies to
// override/revoke (Section 6b): reopening is a different lifecycle
// transition, with a different precondition (status must already be
// 'confirmed', not 'open') and its own audit event, not a variant of
// resolving an open report. Admin-only. Body: { reopen_reason,
// litigation_hold_attestation }, both required, non-empty. Sets
// reopened_at/reopened_by/reopen_reason/litigation_hold_attestation on
// the existing row — NEVER touches status, resolved_by, resolved_at, or
// resolution_notes: the original confirmation stays permanently on this
// same row, exactly like a revoked override still shows both of its own
// life stages (Section 6b's own revoke route). The moment this commits,
// missive_message_intake_search_safe's escalation-exclusion clause stops
// matching this row (it requires reopened_at IS NULL for a 'confirmed'
// row), so the conversation reappears in search on the very next query —
// no separate cleanup step.
//
// Round 3 governance/legal review (compliance/archive-search-escalation-
// mechanism-review.md — a real, attributed Asimov+Mason review, not a
// restatement) NOT-APPROVED an earlier version of this route that only
// carried the archive_search_flagged_overrides revocation precedent by
// analogy: reopening re-exposes correspondence a human already confirmed
// was a real Fair Housing concern, the opposite risk direction from a
// revocation. Mason required two specific changes, both implemented here
// AND at the database level (defense-in-depth, not either/or):
//   1. A different admin must reopen than the one who confirmed —
//      checked here against existing.resolved_by (403 if the same), and
//      enforced independently by archive_search_escalations_reopen_
//      fields_together's CHECK (reopened_by IS DISTINCT FROM
//      resolved_by).
//   2. The litigation-hold reminder is now litigation_hold_attestation:
//      a real, required, separate field (400 if missing/blank) — not
//      folded into reopen_reason text, not a passive SQL comment.
//
// Depends on supabase/migrations/20260912050000_reconcile_20260912040000_
// timestamp_collision.sql (supersedes 20260912040000_add_reopen_to_
// archive_search_escalations.sql — adds all four reopen_*/litigation_
// hold_attestation columns and the strengthened reopen-fields-together
// CHECK this route relies on) being applied FIRST — same "written against
// a migration Peter hasn't applied yet, documented rather than worked
// around" posture Section 6c's own header already carries for this whole
// table. Until that migration is applied, this route 500s (columns do
// not exist) rather than silently doing the wrong thing.
router.post('/api/archive-search/escalations/:id/reopen', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const escalationId = req.params.id;
    const reopenReason = requireNonEmptyReason(req.body.reopen_reason);
    if (!reopenReason) {
      return res.status(400).json({ error: 'reopen_reason is required and cannot be empty.' });
    }
    // Mason's Round 3 requirement #2 (compliance/archive-search-
    // escalation-mechanism-review.md): a structured litigation-hold check,
    // captured as its own required field — never folded into reopen_reason
    // prose, never a passive comment. Validated the same way reopen_reason
    // is, and required independently of it.
    const litigationHoldAttestation = requireNonEmptyReason(req.body.litigation_hold_attestation);
    if (!litigationHoldAttestation) {
      return res.status(400).json({ error: 'litigation_hold_attestation is required and cannot be empty.' });
    }
    // The admin taking this action now — computed once, reused for both
    // the distinct-admin check below and the update itself, so the value
    // checked is guaranteed to be the exact value written.
    const reopeningAdmin = req.archiveSearchMemberName || req.user.email;

    const { data: existing, error: fetchErr } = await supabase
      .from('archive_search_escalations')
      .select('id, missive_conversation_id, mailbox_key, status, resolved_by, reopened_at')
      .eq('id', escalationId)
      .maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) {
      return res.status(404).json({ error: 'No escalation found with that id.' });
    }
    if (existing.status !== 'confirmed') {
      return res.status(409).json({
        error: existing.status === 'open'
          ? 'This escalation is still open and pending review — there is nothing to reopen yet.'
          : 'This escalation was resolved as a false alarm — the conversation is already searchable, there is nothing to reopen.',
      });
    }
    if (existing.reopened_at) {
      return res.status(409).json({ error: 'This escalation has already been reopened.' });
    }
    // Mason's Round 3 requirement #1, his own words "close to a floor
    // requirement, not a nice-to-have": the admin who confirmed a concern
    // is real may not be the same admin who later reopens it alone.
    // Checked here in application code so the requester gets a clear,
    // specific error instead of a raw constraint-violation 500 — the
    // database's own archive_search_escalations_reopen_fields_together
    // CHECK (reopened_by IS DISTINCT FROM resolved_by,
    // supabase/migrations/20260912050000_reconcile_20260912040000_
    // timestamp_collision.sql) still backs this up at the data layer,
    // defense-in-depth, in case this route is ever bypassed or changed.
    if (existing.resolved_by && existing.resolved_by === reopeningAdmin) {
      return res.status(403).json({
        error: 'This escalation must be reopened by a different admin than the one who confirmed it.',
      });
    }

    // .eq('status', 'confirmed').is('reopened_at', null) in the update
    // filter closes the same concurrent-request race window
    // /flagged-override/:overrideId/revoke and this route's own
    // resolve sibling already close for their updates: if two reopen
    // requests land concurrently, only the first actually updates a row;
    // the second gets back zero rows and is told, correctly, that it
    // lost the race — never a silent double-reopen or two contradictory
    // audit events.
    const { data: updatedRows, error: updateErr } = await supabase
      .from('archive_search_escalations')
      .update({
        reopened_at: new Date().toISOString(),
        reopened_by: reopeningAdmin,
        reopen_reason: reopenReason,
        litigation_hold_attestation: litigationHoldAttestation,
      })
      .eq('id', escalationId)
      .eq('status', 'confirmed')
      .is('reopened_at', null)
      .select();
    if (updateErr) throw updateErr;
    if (!updatedRows || updatedRows.length === 0) {
      return res.status(409).json({ error: 'This escalation has already been reopened.' });
    }
    const updated = updatedRows[0];

    await writeAuditLog({
      action: 'archive_search.escalation_reopened',
      entity_type: 'archive_search_escalation',
      entity_id: escalationId,
      actor_email: req.user.email,
      // Hardcoded, never optional — identical Section 4 reasoning as
      // every other human-only event in this file. No code path here
      // ever reopens automatically.
      actor_type: 'human',
      risk_level: 'high',
      privacy_category: 'processing',
      details: {
        escalation_id: escalationId,
        missive_conversation_id: updated.missive_conversation_id,
        mailbox_key: updated.mailbox_key,
        reopen_reason: updated.reopen_reason,
        litigation_hold_attestation: updated.litigation_hold_attestation,
      },
    });

    res.json({ ok: true, escalation: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SECTION 7: internalRouter — no login required, own x-cron-secret check.
// Same pattern as every other tool's internal router in this Hub.
// UPDATE, 2026-09-18: process-pending (screening pass, below) is now on an
// automatic hourly cron (cron-archive-search-screening.sh on Sally).
// process-significance-pending stays Design Decision 16 manually-triggered
// only, pending Asimov's observation-window condition — see that route's
// own comment.
// ============================================================
const internalRouter = express.Router();

function checkCronSecret(req, res) {
  const secret = req.headers['x-cron-secret'];
  if (!secret || secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// In-process overlap guard — same reasoning as every other tool's own
// (e.g. complaint-tracking's processPendingRunning): the Hub runs as a
// single pm2 fork instance, so a module-level boolean is sufficient.
let screeningPassRunning = false;

/**
 * POST /api/archive-search/process-pending
 * Runs exactly ONE chunk of the screening pass (lib/screening-pass.js's
 * runScreeningPassChunk() — spec, "The Screening Pass"; "Build Size and
 * Runtime" requires resumable chunks, not one unbounded pass). Call this
 * repeatedly (by hand, with the x-cron-secret header) until a response
 * comes back with conversations_processed: 0 and errors: 0 — that means
 * nothing is left pending.
 *
 * AUTOMATIC SCHEDULE, added 2026-09-18 (Asimov cleared, condition: the
 * circuit breaker below): cron-archive-search-screening.sh on Sally calls
 * this route once per hour, business hours only, Mon-Fri (see Sally's
 * crontab — the two lines whose command is that script; PDT's business-
 * hours window crosses a UTC day boundary in the evening, so — same as
 * this project's other PDT-anchored cron entries, e.g. the AppFolio nightly
 * sync — it's two crontab lines with different day-of-week fields, not
 * one). One hourly call is normally enough on its own (each call already
 * covers up to SCREENING_PASS_CHUNK_SIZE=500 pending conversations, and
 * ordinary hourly mail volume is far below that); if it's ever not, the
 * next hour's call picks up where the last one left off, same as a human
 * calling this by hand. Manual/by-hand calls (with the x-cron-secret
 * header) still work exactly as before and get the same circuit-breaker
 * protection.
 *
 * CIRCUIT BREAKER, the condition Asimov attached to the automatic schedule
 * above: runScreeningPassChunk() now stops a chunk early — before working
 * through all 500 driver rows — once its own error rate looks unhealthy
 * (see lib/screening-pass.js's CIRCUIT_BREAKER_* constants and
 * circuitBreakerShouldTrip() for the exact thresholds and reasoning). When
 * that happens this route calls sendFailureAlertEmail() (reusing the
 * mechanism above, not a new one) so an unattended hourly run that's
 * mostly failing doesn't just fail silently — Peter gets an email. Pending
 * conversations left over from an early stop are unaffected and get picked
 * up by the next call (hourly cron, or by hand) like any other pending
 * work.
 *
 * Each call's response includes chunk_start/
 * chunk_end (the delivered_at range actually covered) so progress is
 * visible between calls without a separate status lookup, though
 * GET /api/archive-search/screening-status also exists for that.
 */
internalRouter.post('/api/archive-search/process-pending', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  if (screeningPassRunning) {
    return res.status(409).json({ skipped: true, reason: 'already_running', message: 'A previous screening-pass chunk is still in progress.' });
  }
  screeningPassRunning = true;
  const ts = new Date().toISOString();
  try {
    const summary = await runScreeningPassChunk();
    console.log(`[${ts}] archive-search process-pending chunk complete:`, summary);
    // Circuit breaker (lib/screening-pass.js's CIRCUIT_BREAKER_* — the one
    // condition Asimov attached to clearing this route for AUTOMATIC
    // scheduling, 2026-09-18): runScreeningPassChunk() already stops early
    // once a chunk is mostly failing; this is the alert half of that —
    // reusing sendFailureAlertEmail() (Section above) rather than a
    // separate mechanism, same as every other failure alert in this file.
    // Fires on EVERY caller of this route, not just the cron wrapper —
    // deliberately: a human running this by hand deserves the same
    // safety net, and it changes nothing for a normal, healthy chunk.
    if (summary.circuit_breaker_tripped) {
      await sendFailureAlertEmail(
        'Archive Search: screening-pass circuit breaker tripped',
        `The screening pass (POST /api/archive-search/process-pending) stopped a chunk early because its error rate looked unhealthy.\n\n${summary.circuit_breaker_reason}\n\nChunk range: ${summary.chunk_start || 'n/a'} to ${summary.chunk_end || 'n/a'}\nProcessed: ${summary.conversations_processed}, errors: ${summary.errors}\n\nCheck server logs (pm2 logs hub) for the individual conversation failures, then re-run this route (by hand or on its next hourly schedule) once the underlying issue is fixed — pending conversations are unaffected and will be picked up normally.`
      );
    }
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error(`[${ts}] archive-search process-pending failed:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    screeningPassRunning = false;
  }
});

// In-process overlap guard — same reasoning as screeningPassRunning below,
// for the corpus reconciliation job.
let corpusReconciliationRunning = false;

/**
 * POST /api/archive-search/process-corpus-reconciliation
 * The reconciliation job named in projects/hub/email-intake/archive-
 * search-search-performance-security-barrier-spec.md Section 5, "as a
 * function/RPC Peter or a cron can call" (this build's own task). The real
 * mechanism — self-heal, subset-guarantee enforcement, the drift check
 * (Asimov's Condition 2), audit logging, kill-switch activation — all
 * lives in the Postgres function archive_search_corpus_reconcile()
 * (supabase/migrations/20260924010000_archive_search_corpus_schema.sql),
 * callable directly by Peter via Supabase's SQL Editor
 * (SELECT archive_search_corpus_reconcile();) with zero dependency on this
 * route. This route exists only because plain SQL cannot send email: it
 * calls that RPC, then sends sendFailureAlertEmail() when the returned
 * summary flags a condition worth a human's immediate attention — same
 * "reuse the one alert mechanism, don't invent a second one" reasoning
 * as process-pending's own circuit-breaker alert above.
 *
 * x-cron-secret-gated, same pattern as process-pending. NOT itself put on
 * an automatic schedule by this build — that's Scotty's call, same as
 * process-pending's own cron-archive-search-screening.sh wrapper (not in
 * git). Proposed cadence, per the spec: every 15 minutes — TARS should
 * confirm real run time first (see this function's own COMMENT).
 *
 * Deliberately does nothing until archive_search_corpus_reconcile() exists
 * in production (i.e., until 20260924010000 is applied) — the RPC call
 * below fails with a normal Postgres "function does not exist" error,
 * caught and returned as a 500, same as any other route calling a
 * not-yet-applied migration's object. No corpus-cutover flag gates this
 * route the way ARCHIVE_SEARCH_CORPUS_SEARCH_ENABLED gates GET
 * /api/archive-search/search — running reconciliation against an empty or
 * partially-backfilled corpus is safe and expected (the RPC's own header
 * comment covers this), unlike serving live search results from it.
 */
internalRouter.post('/api/archive-search/process-corpus-reconciliation', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  if (corpusReconciliationRunning) {
    return res.status(409).json({ skipped: true, reason: 'already_running', message: 'A previous corpus reconciliation run is still in progress.' });
  }
  corpusReconciliationRunning = true;
  const ts = new Date().toISOString();
  try {
    const { data: summary, error } = await supabase.rpc('archive_search_corpus_reconcile');
    if (error) throw error;
    console.log(`[${ts}] archive-search corpus reconciliation complete:`, summary);

    // Alert conditions — every one of these is a case the spec's own
    // severity table (Section 5) says should reach a human immediately,
    // not just self-heal silently: a systemic superset violation (the
    // kill-switch itself, already flipped by the RPC by this point), a
    // gap that repeated across consecutive runs (a routinely-failing
    // becoming-eligible trigger, not a one-off), or any drift-check
    // mismatch (Asimov's Condition 2 — the one check standing in for the
    // 7-day observation window Peter's waiver skipped).
    const alertReasons = [];
    if (summary && summary.systemic_violation) alertReasons.push('systemic superset violation — kill-switch activated, search now falls back to missive_message_intake_search_safe');
    if (summary && summary.gap_repeated_across_consecutive_runs) alertReasons.push('sync gap repeated across consecutive reconciliation runs — the becoming-eligible trigger may be failing routinely');
    if (summary && summary.drift_mismatch_count > 0) alertReasons.push(`corpus/view drift detected — ${summary.drift_mismatch_count} of ${summary.drift_sample_size} sampled row(s) disagreed with missive_message_intake_search_safe's real predicate`);

    if (alertReasons.length > 0) {
      await sendFailureAlertEmail(
        'Archive Search: corpus reconciliation found a condition needing review',
        `archive_search_corpus_reconcile() flagged:\n\n${alertReasons.map((r) => `- ${r}`).join('\n')}\n\nFull run summary:\n${JSON.stringify(summary, null, 2)}\n\nSee audit_log (action LIKE 'archive_search.corpus_%') for the full detail on this run and prior ones. If the kill-switch is active, clear it only after confirming corpus health (see archive_search_corpus_reconciliation_state's own COMMENT for the clear statement).`
      );
    }

    res.json({ ok: true, ...summary, alerted: alertReasons.length > 0 });
  } catch (err) {
    console.error(`[${ts}] archive-search corpus reconciliation failed:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    corpusReconciliationRunning = false;
  }
});

// In-process overlap guard — same reasoning as screeningPassRunning above.
let significancePassRunning = false;

// Default limit — deliberately small, and NOT the same 200-ceiling this
// build's pilot uses. Each conversation here can cost up to two AI calls
// (Call 1, up to CALL1_MAX_ATTEMPTS retries; Call 2, up to
// CALL2_MAX_ATTEMPTS), each with its own ~30s timeout — unlike screening-
// pass.js's single cheap self-report call per conversation, a worst-case
// conversation here can take on the order of a minute or two. A single
// HTTP request processing 200 of those risks tripping a proxy/gateway
// timeout (nginx's own default, or the caller's own curl timeout) well
// before the request actually finishes — the exact failure mode
// SCREENING_PASS_CHUNK_SIZE's own "stay inside one HTTP request's
// timeout" reasoning exists to avoid, just for a heavier per-item cost
// here. Since this route serves ONLY the ongoing, low-daily-trickle live
// loop (spec Section 10) — not the pilot, which runs run-significance-
// pilot.js directly, in-process, with no HTTP request wrapping it at
// all — a small default is the safer, still-simple choice; ?limit=
// overrides it for an admin who knows a longer call is fine.
const LIVE_SIGNIFICANCE_PASS_DEFAULT_LIMIT = 20;

/**
 * POST /api/archive-search/process-significance-pending
 * Runs the merged significance + complaint-triage pass (lib/
 * significance-pass.js) against LIVE mail only — discoveryContext:
 * 'live_pipeline' (archive-search-significance-technical-spec.md v2,
 * Section 10's "ongoing, forward-looking" loop). This is the route that
 * replaces complaint-tracking's own retired POST /api/complaint-tracking/
 * process-pending (see that file's own header for the full retirement
 * record) — one AI read per conversation now answers both "what's this
 * about" and "does someone need to act on this," never two independent
 * categorizers on the same mail. Manually triggered only (x-cron-secret-
 * gated), same posture as process-pending above. Call repeatedly until a
 * response comes back with conversations_processed: 0 and errors: 0.
 *
 * Deliberately NOT the route the one-time historical backfill pilot uses
 * — that runs as its own standalone script directly on sally (run-
 * significance-pilot.js), per spec Section 10's explicit "runs entirely
 * on sally... launched... via nohup ... & disown" requirement, restated
 * because this exact mistake (running this kind of pass locally) already
 * happened once on this project.
 *
 * OPTIONAL ?since_date=YYYY-MM-DD (Peter's staged-by-recency backfill
 * request, 2026-09-17) — same semantics/param as run-significance-
 * pilot.js's --since-date (see lib/significance-pass.js's sinceDate block
 * for the full argument): a conversation only becomes eligible if its
 * MOST RECENT message is on/after this date. Omitted by default, which is
 * the ENTIRE existing behavior of this route, unchanged.
 *
 * WHY THIS IS HERE AT ALL, checked rather than assumed: the obvious guess
 * — "the live route doesn't need a date cutoff, since live mail is
 * always recent by definition" — turns out not to actually hold, for a
 * reason specific to this schema: the underlying message table's `id`
 * column (confirmed against its own schema migration, 20260905020000) is
 * a random UUID (gen_random_uuid()), not a time-ordered sequence.
 * This route's own eligibility rule (fetchNextEligibleConversations, lib/
 * significance-pass.js) is "no significance row yet," full stop — it has
 * no built-in notion of "newly arrived" at all, and a random-UUID id order
 * gives it no incidental recency bias either. Confirmed live: as of
 * 2026-09-17 this route has literally never been run (zero discovery_
 * context='live_pipeline' rows exist in missive_conversation_significance
 * — all 192 real rows are historical_backfill), and it is manually
 * triggered only (x-cron-secret-gated, no crontab entry anywhere in this
 * repo or on sally per deploy-to-sally.sh) — so there is no live
 * production risk TODAY. The risk this guards against is a FUTURE one:
 * if this route is ever run while the staged historical backfill has
 * deliberately left older, out-of-scope conversations unprocessed (no
 * significance row yet, by design, pending Peter's later go-ahead), this
 * route could just as easily pick one of THOSE up as it could a genuinely
 * new message, mislabeling it discovery_context='live_pipeline'. ?since_
 * date= lets whoever runs this route (Peter or Scotty) restrict it to
 * true recent activity if it's ever used during a staged backfill window
 * — not required for ordinary use once the archive is fully caught up.
 */
internalRouter.post('/api/archive-search/process-significance-pending', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  if (significancePassRunning) {
    return res.status(409).json({ skipped: true, reason: 'already_running', message: 'A previous significance-pass run is still in progress.' });
  }
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : LIVE_SIGNIFICANCE_PASS_DEFAULT_LIMIT;
  const sinceDateParam = typeof req.query.since_date === 'string' ? req.query.since_date : null;
  if (sinceDateParam && (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDateParam) || Number.isNaN(new Date(sinceDateParam).getTime()))) {
    return res.status(400).json({ error: `since_date must be a valid YYYY-MM-DD date, got "${sinceDateParam}".` });
  }

  significancePassRunning = true;
  const ts = new Date().toISOString();
  try {
    // Cross-process lock (lib/significance-lock.js — Asimov's flagged gap,
    // 2026-09-18): significancePassRunning above only guards against
    // overlap with ANOTHER CALL TO THIS SAME ROUTE, inside this one pm2
    // process. It does nothing against run-significance-batch.js or
    // run-significance-pilot.js, which run as their own separate `node`
    // processes on Sally (nohup'd by hand) and never see that flag. This
    // acquires the SAME lock those two standalone scripts now also
    // acquire, so this route can never run at the same time as either of
    // them either.
    const summary = await withSignificanceLock('manual-live-pipeline-route', () =>
      runSignificancePassBatch({ limit, discoveryContext: 'live_pipeline', sinceDate: sinceDateParam })
    );
    console.log(`[${ts}] archive-search process-significance-pending complete:`, summary);
    res.json({ ok: true, ...summary });
  } catch (err) {
    if (err instanceof SignificancePassLockedError) {
      console.warn(`[${ts}] archive-search process-significance-pending skipped — locked: ${err.message}`);
      return res.status(409).json({ skipped: true, reason: 'locked_by_other_process', message: err.message });
    }
    console.error(`[${ts}] archive-search process-significance-pending failed:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    significancePassRunning = false;
  }
});

// ============================================================
// AUTOMATIC SCHEDULE FOR THE SIGNIFICANCE PASS — BUILT, NOT ACTIVE.
// Added 2026-09-18 alongside the screening pass's automatic schedule
// (process-pending, above), per Asimov's SPLIT verdict on that same
// review: the screening pass cleared for automatic scheduling; this pass
// did NOT — Asimov wants a real, human-reviewed observation window against
// the now-fixed code first (its first-ever real production run, the
// 84,408-conversation historical backfill, started 2026-09-18 and is what
// that observation window is watching). This route and the cross-process
// lock it uses are both real and both wired in — the ONLY thing standing
// between this and actually running automatically is the crontab entry on
// Sally, which deliberately does not exist, PLUS the feature flag checked
// immediately below, which deliberately defaults to off. Both gates are
// independent of each other on purpose — either one alone would already
// stop this from running unattended.
//
// EXACTLY WHAT TURNS THIS ON LATER, once Asimov confirms the observation
// window is satisfied (do not do any of this before then):
//   1. Set ARCHIVE_SEARCH_SIGNIFICANCE_CRON_ENABLED=true in Sally's
//      /var/www/hub/.env (see .env.example for the full comment).
//   2. Create /var/www/hub/cron-archive-search-significance.sh on Sally
//      BY HAND (this project's cron-*.sh scripts live only on Sally, never
//      in git — see deploy-to-sally.sh's own header for why), same shape
//      as cron-archive-search-screening.sh (created alongside this same
//      change for the screening pass):
//        #!/bin/bash
//        set -a
//        source /var/www/hub/.env
//        set +a
//        curl -s -X POST -H "X-Forwarded-Proto: https" -H "x-cron-secret: $CRON_SECRET" \
//          "http://localhost:3500/api/archive-search/process-significance-pending-scheduled"
//      then `chmod 700` it (matching this project's other cron-*.sh
//      permissions) and confirm CRON_SECRET is really set in that same
//      .env first.
//   3. Add these two crontab lines (`crontab -e` on Sally) — same hourly,
//      business-hours-only, PDT-anchored shape as the screening pass's own
//      two lines (see cron-archive-search-screening.sh's crontab entry for
//      why it's two lines, not one):
//        0 15-23 * * 1-5 /var/www/hub/cron-archive-search-significance.sh >> /var/log/archive-search-significance.log 2>&1
//        0 0 * * 2-6 /var/www/hub/cron-archive-search-significance.sh >> /var/log/archive-search-significance.log 2>&1
//   4. Verify: check /var/log/archive-search-significance.log after the
//      next scheduled hour and confirm a real run happened with a
//      reasonable summary (no wall of errors) before walking away.
// ============================================================

// Feature flag — second, independent gate (see comment above). Defaults
// OFF: unset, empty, or anything other than the literal string 'true'
// means disabled. Deliberately the opposite default polarity from this
// codebase's other feature flag (maintenance-history's
// TIER_B_CONTEXTUAL_CHECK_ENABLED, which defaults ON unless explicitly
// 'false') — that one guards an already-cleared feature being toggled off
// as an escape hatch; this one guards a NOT-yet-cleared feature that must
// stay off until someone deliberately opts it in.
function significanceCronEnabled() {
  return process.env.ARCHIVE_SEARCH_SIGNIFICANCE_CRON_ENABLED === 'true';
}

/**
 * POST /api/archive-search/process-significance-pending-scheduled
 * Identical body to process-significance-pending above (same
 * runSignificancePassBatch() call, same live_pipeline discoveryContext,
 * same ?limit=/?since_date= params, same cross-process lock) — this is a
 * SEPARATE route, not a modification of the existing manually-triggered
 * one, specifically so the existing route's behavior for Peter's own
 * by-hand calls never changes, and so the "is this automatic yet" answer
 * lives in one obvious place (this route + the flag below) rather than as
 * a conditional buried inside the route everyone already relies on.
 *
 * Refuses to run at all — 403, does not touch runSignificancePassBatch()
 * or the lock — unless ARCHIVE_SEARCH_SIGNIFICANCE_CRON_ENABLED=true. See
 * the big comment above for exactly what else has to be true (a real
 * crontab entry on Sally) before this route is ever actually called on a
 * schedule; today, nothing calls it.
 */
internalRouter.post('/api/archive-search/process-significance-pending-scheduled', async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  if (!significanceCronEnabled()) {
    return res.status(403).json({
      error: 'The significance pass is not yet cleared for automatic scheduling (Asimov: observation window against the now-fixed code required first). ' +
        'Set ARCHIVE_SEARCH_SIGNIFICANCE_CRON_ENABLED=true only once that condition is actually satisfied — see this route\'s own comment in router.js.',
    });
  }
  if (significancePassRunning) {
    return res.status(409).json({ skipped: true, reason: 'already_running', message: 'A previous significance-pass run is still in progress.' });
  }
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : LIVE_SIGNIFICANCE_PASS_DEFAULT_LIMIT;
  const sinceDateParam = typeof req.query.since_date === 'string' ? req.query.since_date : null;
  if (sinceDateParam && (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDateParam) || Number.isNaN(new Date(sinceDateParam).getTime()))) {
    return res.status(400).json({ error: `since_date must be a valid YYYY-MM-DD date, got "${sinceDateParam}".` });
  }

  significancePassRunning = true;
  const ts = new Date().toISOString();
  try {
    const summary = await withSignificanceLock('cron-live-pipeline', () =>
      runSignificancePassBatch({ limit, discoveryContext: 'live_pipeline', sinceDate: sinceDateParam })
    );
    console.log(`[${ts}] archive-search process-significance-pending-scheduled complete:`, summary);
    res.json({ ok: true, ...summary });
  } catch (err) {
    if (err instanceof SignificancePassLockedError) {
      console.warn(`[${ts}] archive-search process-significance-pending-scheduled skipped — locked: ${err.message}`);
      return res.status(409).json({ skipped: true, reason: 'locked_by_other_process', message: err.message });
    }
    console.error(`[${ts}] archive-search process-significance-pending-scheduled failed:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    significancePassRunning = false;
  }
});

// ─── GET /api/archive-search/significance-pilot-export — admin-only.
// Peter's own way to actually look at the pilot's results (spec Section
// 12's shadow-mode exit criterion: "100 (possibly 200) reviewed
// conversations... reviewed by hand before anything expands further").
// Same CSV-export pattern as validation-sample-export/held-review-export
// above — this build's own precedent for "the reviewer needs the real
// content to judge it," not a new mechanism. Exports EVERY row currently
// in missive_conversation_significance for discovery_context =
// 'historical_backfill' (the pilot population) plus its linked complaint,
// if one exists — not scoped to "the last N," since the pilot is a fixed,
// one-time, bounded batch (Section 12) and Peter needs to see all of it,
// not a moving window.
router.get('/api/archive-search/significance-pilot-export', requireArchiveSearchAdmin, async (req, res) => {
  try {
    const { data: significanceRows, error: sigErr } = await supabase
      .from('missive_conversation_significance')
      .select('*')
      .eq('discovery_context', 'historical_backfill')
      .order('computed_at', { ascending: true });
    if (sigErr) throw sigErr;
    if (!significanceRows || significanceRows.length === 0) {
      return res.status(404).json({ error: 'No historical_backfill significance rows found yet — has the pilot script been run on sally?' });
    }

    const complaintIds = significanceRows.map((r) => r.complaint_id).filter(Boolean);
    const complaintsById = new Map();
    if (complaintIds.length) {
      const { data: complaintRows, error: compErr } = await supabase
        .from('complaints').select('id, escalation_signal, needs_human_call, owner_instruction_rejected, status')
        .in('id', complaintIds);
      if (compErr) throw compErr;
      for (const c of complaintRows || []) complaintsById.set(c.id, c);
    }

    const exportRows = significanceRows.map((s) => {
      const complaint = s.complaint_id ? complaintsById.get(s.complaint_id) : null;
      return {
        mailbox_key: s.mailbox_key,
        missive_conversation_id: s.missive_conversation_id,
        missive_link: missiveConversationLink(s.missive_conversation_id),
        resolution_status: s.resolution_status,
        category: s.category,
        why: s.why,
        tone_trend: s.tone_trend || '',
        // protected_class_flag deliberately dropped from this export, 2026-09-17
        // (Judge review, sixth spec correction): Call 1's own self-check question
        // was removed and the column is now hardcoded false on every row going
        // forward, indistinguishable in this export from a real historical "no."
        // keyword_check_flagged_protected_class (checkClaim(), untouched) is the
        // one real, meaningful signal left.
        keyword_check_flagged_protected_class: s.keyword_check_flagged_protected_class,
        escalation_signal: s.escalation_signal || '',
        needs_human_call: s.needs_human_call,
        owner_instruction_rejected: s.owner_instruction_rejected || '',
        // owner_instruction_note_text's MEANING changed 2026-09-17 (Peter's
        // decision, Mason CLEARED — compliance/archive-search-significance-
        // complaint-merge-mason-review.md, "Follow-up to Finding 2"): this
        // column used to hold an AI-drafted response/assessment (a fixed
        // live-mail refusal string, or a historical "AI-assessed..." string).
        // Both are gone. It now holds only owner_instruction_summary — a
        // plain factual paraphrase of the owner's instruction, nothing more
        // — reusing the same column/slot rather than adding a new one. Rows
        // written before this change may still show old drafted text; rows
        // written after only ever show the factual summary or blank.
        owner_instruction_note_text: s.owner_instruction_note_text || '',
        is_big_issue: s.is_big_issue,
        call2_completed_at: s.call2_completed_at || '',
        complaint_created: !!complaint,
        complaint_status: complaint ? complaint.status : '',
      };
    });

    const csv = toCsv(
      ['mailbox_key', 'missive_conversation_id', 'missive_link', 'resolution_status', 'category', 'why', 'tone_trend',
        'keyword_check_flagged_protected_class', 'escalation_signal', 'needs_human_call',
        'owner_instruction_rejected', 'owner_instruction_note_text', 'is_big_issue', 'call2_completed_at',
        'complaint_created', 'complaint_status'],
      exportRows
    );

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="archive-search-significance-pilot-export.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  router,
  internalRouter,
  attachArchiveSearchRole,
  requireArchiveSearchAccess,
  requireArchiveSearchAdmin,
  ARCHIVE_SEARCH_SEARCH_ROLES,
  ARCHIVE_SEARCH_ADMIN_ROLES,
  missiveConversationLink,
  buildSnippet,
  extractQueryTerms,
  SEARCH_PAGE_SIZE,
};
