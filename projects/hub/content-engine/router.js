/**
 * content-engine/router.js
 * Content Engine — a new section of the Rincon Hub. Content Engine itself
 * has no UI today; it's run from the command line (draft-content.js,
 * scan-legal-updates.js, scan-viral-topics.js). This router gives Peter's
 * team a page with buttons for the same three actions, plus a simple
 * recent-activity view — same drafting/scanning logic, called directly
 * (not spawned as a CLI subprocess), same as content-review/server.js
 * already does for draftContent()/reviseContent()/etc.
 *
 * Every content-engine lib file this router calls is required through
 * ../lib/content-engine-paths.js's contentEnginePath() — content-engine's
 * code is not moved or copied, it stays at projects/content-engine/.
 *
 * Built the same way Insurance Compliance, Security Deposit, Maintenance
 * History, and Call Stats were: one router file, mounted into
 * projects/hub/server.js, reusing the Hub's existing login.
 * Access: team_member_tool_roles, tool='content_engine'. This build (per
 * Oracle's plan) treats 'admin' and 'contributor' as equally trusted for
 * every action in THIS panel — drafting, and running the two discovery
 * scans, are all lower-stakes than the approve/reject/publish/legal-claim/
 * brand-guide decisions that live in content-review/router.js (the panel
 * this one hands its output off to for review). Nothing here needs
 * anything more restrictive than "holds a role at all."
 *
 * Two routers exported, same pattern as every other Hub tool:
 *   router          Everything a logged-in hub user with content_engine
 *                    access can reach: the dashboard page and all
 *                    /api/content-engine/* routes. Mounted AFTER
 *                    requireLogin in server.js.
 *   internalRouter   Reserved for a future scheduled/cron version of the
 *                    two discovery scans (today they're both Peter-
 *                    triggered from the dashboard button, not on a
 *                    schedule) — kept as an empty router now so
 *                    server.js's mounting pattern matches every other
 *                    tool exactly, and so adding a real cron route later
 *                    (shared-secret-authenticated, same as the other four
 *                    tools' internalRouters) doesn't require touching
 *                    server.js's mount order again. Must still be
 *                    registered BEFORE requireLogin in server.js, for
 *                    when that day comes.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const { contentEnginePath } = require('../lib/content-engine-paths');
const { GLOBAL_SEARCH_WIDGET_HTML } = require('../lib/global-search-widget');

const { draftContent, VALID_CONTENT_TYPES } = require(contentEnginePath('lib/draft'));
const { listTopics } = require(contentEnginePath('lib/compliance'));
const { runLegalUpdateScan, logScanRun: logLegalUpdateScanRun } = require(contentEnginePath('lib/legal-update-scan'));
const { runViralTrendScan, logScanRun: logViralScanRun } = require(contentEnginePath('lib/viral-scan'));

// ─── Config ─────────────────────────────────────────────────────────────
// ANTHROPIC_API_KEY is checked lazily by content-engine/lib/anthropic.js
// itself (throws a clear error the first time a draft/scan actually needs
// it) — not required here at startup, same reasoning maintenance-history's
// router gives for LATCHEL_API_KEY: a missing key shouldn't take down the
// whole Hub, only the one action that needs it. LEGISCAN_API_KEY and
// YOUTUBE_API_KEY are likewise checked lazily inside their own scan
// modules. See .env.example for all three.
const missing = [];
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (missing.length > 0) {
  console.error(`[content-engine] Missing environment variables: ${missing.join(', ')}`);
  console.error('[content-engine] Set these in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Permission check — reads Neo's shared team tables ─────────────────
// Same fail-closed pattern as the other four tools' routers: any lookup
// error leaves req.contentEngineRole null rather than throwing, so a
// database hiccup denies access instead of accidentally granting it.
async function attachContentEngineRole(req, res, next) {
  req.contentEngineRole = null;
  req.teamMemberId = null;
  req.contentEngineMemberName = null;

  try {
    const { data: member, error: memberErr } = await supabase
      .from('team_members')
      .select('id, full_name, is_active')
      .eq('auth_user_id', req.user.id)
      .maybeSingle();
    if (memberErr) throw memberErr;
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.contentEngineMemberName = member.full_name || null;

    const { data: roleRow, error: roleErr } = await supabase
      .from('team_member_tool_roles')
      .select('role')
      .eq('team_member_id', member.id)
      .eq('tool', 'content_engine')
      .maybeSingle();
    if (roleErr) throw roleErr;
    req.contentEngineRole = roleRow ? roleRow.role : null;
    next();
  } catch (err) {
    console.error('[content-engine] permission lookup failed:', err.message);
    next();
  }
}

// Both 'admin' and 'contributor' pass this — everything in this panel is
// open to anyone holding either role (see file header). No
// requireContentEngineRole(...specificRoles) helper exists in this file
// because nothing here ever needs to single out 'admin' — that
// restriction lives entirely in content-review/router.js.
function requireContentEngineAccess(req, res, next) {
  if (!req.contentEngineRole) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Content Engine yet. Ask an admin to grant you access.',
    });
  }
  next();
}

// ─── Router: everyone reaching here is already hub-logged-in ───────────
const router = express.Router();
router.use(attachContentEngineRole);

router.get('/content-engine', (req, res) => {
  fs.readFile(path.join(__dirname, 'dashboard', 'index.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Could not load page.');
    res.send(html.replace('<body>', '<body>\n' + GLOBAL_SEARCH_WIDGET_HTML));
  });
});

router.get('/api/content-engine/auth/me', requireContentEngineAccess, (req, res) => {
  res.json({
    email: req.user.email,
    name: req.contentEngineMemberName || req.user.email,
    role: req.contentEngineRole,
  });
});

// ─── GET /api/content-engine/topics — for the "Draft a new post" form's ───
// topic checkboxes. Same source content-review's /ideas/new and /social/new
// forms already use (content-engine/lib/compliance.js's listTopics()) — the
// real, current compliance_topics list, not a hand-maintained duplicate.
router.get('/api/content-engine/topics', requireContentEngineAccess, async (req, res) => {
  try {
    const topics = await listTopics();
    res.json(topics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/content-engine/content-types', requireContentEngineAccess, (req, res) => {
  res.json(VALID_CONTENT_TYPES);
});

// ─── POST /api/content-engine/draft — "Draft a new post" button ───────────
// Calls draftContent() directly — the exact same function draft-content.js's
// CLI and content-review's /ideas/generate use, so the prompt/grounding
// logic is never duplicated a third time. Only ever creates a content_items
// row with status='draft'; the resulting draft goes to the normal Content
// Review queue (/content-review) for approval — nothing here publishes,
// sends, or posts anything. Takes ~20-30 seconds (a real Claude API call).
router.post('/api/content-engine/draft', requireContentEngineAccess, async (req, res) => {
  try {
    const { title, brief, content_type, topics, inspiration_piece } = req.body;
    const topicKeywords = Array.isArray(topics) ? topics : (topics ? [topics] : []);
    const inspirationPiece =
      typeof inspiration_piece === 'string' && inspiration_piece.trim() ? inspiration_piece.trim() : null;

    if (!title || !title.trim()) return res.status(400).json({ error: 'A working title is required.' });
    if (!brief || !brief.trim()) return res.status(400).json({ error: 'Please describe what the piece should cover.' });
    if (!VALID_CONTENT_TYPES.includes(content_type)) {
      return res.status(400).json({ error: `Content type must be one of: ${VALID_CONTENT_TYPES.join(', ')}` });
    }

    const start = Date.now();
    const { contentItem, claimsUsed, claimsFlaggedForReview } = await draftContent({
      title: title.trim(),
      brief: brief.trim(),
      contentType: content_type,
      topicKeywords,
      authorName: req.contentEngineMemberName || req.user.email,
      inspirationPiece,
    });
    console.log(`[content-engine] draftContent "${title}" succeeded in ${Date.now() - start}ms (item ${contentItem.id})`);

    res.json({
      id: contentItem.id,
      title: contentItem.title,
      claimsUsed: claimsUsed.length,
      claimsFlaggedForReview: claimsFlaggedForReview.length,
      reviewUrl: `/content-review/items/${contentItem.id}`,
    });
  } catch (err) {
    console.error('[content-engine] draftContent failed:', err.message);
    res.status(500).json({ error: 'Draft generation failed. This is usually a temporary issue — please try again.' });
  }
});

// ─── POST /api/content-engine/scan-legal-updates — "Check for legal ──────
// updates" button. Same runLegalUpdateScan()/logScanRun() pair
// scan-legal-updates.js's CLI uses, called inline instead of spawned as a
// subprocess. Every run (success or failure) is logged to
// legal_update_scan_runs, same as the CLI — this is also what the recent-
// activity view below reads from. Never writes to compliance_claims and
// never decides a bill is a real legal fact — see lib/legal-update-scan.js's
// own header comment.
router.post('/api/content-engine/scan-legal-updates', requireContentEngineAccess, async (req, res) => {
  const stats = { candidatesCreated: 0 };
  try {
    await runLegalUpdateScan(stats);
    await logLegalUpdateScanRun({
      succeeded: true,
      candidatesCreated: stats.candidatesCreated,
      errorMessage: stats.topicSearchWarning || null,
    });
    res.json({
      succeeded: true,
      candidatesCreated: stats.candidatesCreated,
      warning: stats.topicSearchWarning || null,
    });
  } catch (err) {
    await logLegalUpdateScanRun({
      succeeded: false,
      candidatesCreated: stats.candidatesCreated,
      errorMessage: err.message,
    });
    console.error('[content-engine] legal update scan failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/content-engine/scan-viral-topics — "Check for trending ────
// topics" button. Same runViralTrendScan()/logScanRun() pair
// scan-viral-topics.js's CLI uses. Every run is logged to topic_scan_runs
// (feed_source='viral_trend_scan') — read by both this panel's recent-
// activity view and content-review's /topics page's scan-status banner.
// Never drafts anything and never touches content_items — see
// lib/viral-scan.js's own header comment.
router.post('/api/content-engine/scan-viral-topics', requireContentEngineAccess, async (req, res) => {
  const stats = { suggestionsCreated: 0 };
  try {
    await runViralTrendScan(stats);
    await logViralScanRun({ succeeded: true, suggestionsCreated: stats.suggestionsCreated });
    res.json({ succeeded: true, suggestionsCreated: stats.suggestionsCreated });
  } catch (err) {
    await logViralScanRun({
      succeeded: false,
      suggestionsCreated: stats.suggestionsCreated,
      errorMessage: err.message,
    });
    console.error('[content-engine] viral topic scan failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/content-engine/activity — simple recent-activity view ──────
// Three separate, small lists rather than one merged timeline — simplest
// thing that works, and each source already has its own distinct shape.
// Sourced entirely from tables Neo already built (content_items,
// legal_update_scan_runs, topic_scan_runs) — no new schema for this build.
// Note: a draftContent() call that FAILS leaves no row here (there's
// nothing to log a failure against, unlike the two scan actions, which
// always log a run either way) — the person who triggered it sees the
// error immediately on the dashboard instead. A persistent log of failed
// draft attempts would need a new table, which is Neo's call, not made
// here.
router.get('/api/content-engine/activity', requireContentEngineAccess, async (req, res) => {
  try {
    const [{ data: drafts, error: draftsErr }, { data: legalRuns, error: legalErr }, { data: topicRuns, error: topicErr }] =
      await Promise.all([
        supabase
          .from('content_items')
          .select('id, title, content_type, status, author_name, created_at')
          .order('created_at', { ascending: false })
          .limit(10),
        supabase
          .from('legal_update_scan_runs')
          .select('ran_at, succeeded, candidates_created, error_message')
          .order('ran_at', { ascending: false })
          .limit(10),
        supabase
          .from('topic_scan_runs')
          .select('feed_source, ran_at, succeeded, suggestions_created, error_message')
          .order('ran_at', { ascending: false })
          .limit(10),
      ]);
    if (draftsErr) throw draftsErr;
    if (legalErr) throw legalErr;
    if (topicErr) throw topicErr;

    res.json({
      drafts: drafts || [],
      legalUpdateScans: legalRuns || [],
      topicScans: topicRuns || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── internalRouter — empty today, see file header ─────────────────────
const internalRouter = express.Router();

module.exports = { router, internalRouter };
