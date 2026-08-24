/**
 * content-review/router.js
 * Content Review, migrated from projects/content-review/server.js into a
 * section of the Rincon Hub, mounted at /content-review (every page) and
 * reusing content-engine's actual drafting/revision/chat/caption functions
 * (unchanged, required through ../lib/content-engine-paths.js's
 * contentEnginePath() — content-engine's code is not moved or copied).
 *
 * WHAT CHANGED FROM THE STANDALONE APP — READ THIS FIRST
 *   1. Login: content-review used to run its own Supabase Auth session
 *      (its own /login, /reset-password, express-session, cookie). All of
 *      that is gone. Everyone reaching any route in this file has ALREADY
 *      been authenticated by the Hub's shared login (lib/middleware.js's
 *      requireLogin, mounted in server.js before this router) — the same
 *      login as every other Hub section. There is no second sign-in
 *      screen. req.session.userEmail (used throughout this file for
 *      "edited_by"/author attribution, exactly as before) is set by the
 *      Hub's own POST /login, so every reference to it below still works
 *      unchanged.
 *   2. Permissions — THE PART THAT DID NOT EXIST BEFORE: the standalone
 *      app had no role check at all — any valid session could do anything,
 *      including approve/reject/publish a draft or edit the brand voice
 *      guide. attachContentEngineRole() below looks up Neo's shared
 *      team_members / team_member_tool_roles tables (tool='content_engine')
 *      on every request and attaches req.contentEngineRole ('admin' or
 *      'contributor', or null if this person has no access at all).
 *        - requireContentEngineAccessPage / requireContentEngineAccess
 *          (JSON variant, for the handful of fetch()-driven routes) let
 *          BOTH roles through — everything in this file except the five
 *          actions below is open to any team member holding either role.
 *        - requireContentEngineAdminOrRedirect(...) is the new,
 *          previously-missing gate: approve, reject, mark-published, a
 *          legal-claim decision, and saving a new brand-voice-guide
 *          version are now admin-only, enforced server-side on the POST
 *          route itself (not just a hidden button) — see each route below.
 *      The item detail / legal-review / brand-guide PAGES themselves also
 *      hide those specific forms from a non-admin viewer (so a
 *      contributor never sees a button that would just 403), but the
 *      real enforcement is the server-side check, not the hidden markup.
 *   3. Paths: every route is prefixed with /content-review (e.g. GET /
 *      -> GET /content-review, POST /items/:id/approve -> POST
 *      /content-review/items/:id/approve) so it can be mounted alongside
 *      the Hub's other sections without colliding with any of them.
 *      Every href, form action, redirect, and client-side fetch() URL in
 *      this file was updated to match — there is no bare "/items/..." or
 *      "/topics" left anywhere below.
 *   4. Static assets: the two plain client-side helper scripts
 *      (dictation.js, generation-fetch.js) are served from
 *      /content-review/static/*.js (see the express.static line below —
 *      deliberately a distinct sub-path, not /content-review itself; see
 *      that line's own comment for why) instead of the standalone app's
 *      site root, and every <script src> tag was updated to match.
 *   5. Two inline event-handler attributes from the standalone app
 *      (onclick="this.select()" on the FAQ-schema textarea, and
 *      onsubmit="return confirm(...)" on the Reject form) are gone,
 *      replaced with real <script> blocks using addEventListener. Reason:
 *      the Hub's helmet CSP (server.js) sets script-src-attr 'none' (see
 *      helmet's own default directives, not overridden there), which
 *      SILENTLY blocks inline onX= attributes even though it allows this
 *      file's own inline <script> blocks — confirmed as a live, working
 *      pattern already in call-stats/dashboard/index.html. Left as
 *      onclick/onsubmit here, both would have silently stopped working the
 *      moment this router was mounted into the Hub.
 *   6. Business logic — the drafting/revision/chat/caption calls, the
 *      compliance-claims display, the legal-review checkpoint, the
 *      section-level editor, the brand voice guide, the archive/unarchive
 *      pattern, the topic-suggestions and legal-updates triage queues, the
 *      standalone social posts — is UNCHANGED. Every route below does
 *      exactly what it did in the standalone app, just re-homed here with
 *      the role gate added on top.
 *
 * NOT migrated: content-review's own /login, /reset-password, and its
 * lib/auth.js / lib/middleware.js (Supabase session handling) — superseded
 * entirely by the Hub's shared login. Not migrated because there is
 * nothing left for them to do here.
 *
 * Only one router is exported (no internalRouter) — unlike the other four
 * Hub tools, nothing in the standalone content-review app ever ran on a
 * schedule or needed a shared-secret-authenticated endpoint; it is a
 * 100%-human-triggered review UI. Mount only `router`, AFTER requireLogin
 * in server.js, same position as every other tool's main router.
 */

const express = require('express');
const path = require('path');

const { contentEnginePath } = require('../lib/content-engine-paths');

const { select, selectOne, insert, update, updateOne } = require('./lib/db');
const layoutModule = require('./lib/layout');
const { escapeHtml } = layoutModule;
const { renderDraftBody, countReviewFlags } = require('./lib/highlight');
const { renderBodyDiff } = require('./lib/diff-render');

// content-engine is a sibling project directory, reached only through
// contentEnginePath() — see that helper's own header comment. We reuse its
// actual drafting/revision/chat/caption functions here rather than
// re-implementing any of that logic — the exact same code path
// content-engine's own CLI scripts and the new content-engine/router.js
// panel use, just called directly.
const { draftContent, VALID_CONTENT_TYPES } = require(contentEnginePath('lib/draft'));
const { listTopics } = require(contentEnginePath('lib/compliance'));
const { reviseContent } = require(contentEnginePath('lib/revise'));
const { handleChatMessage } = require(contentEnginePath('lib/chat'));
const { generateCaptions } = require(contentEnginePath('lib/captions'));
const { generateStandaloneCaptions } = require(contentEnginePath('lib/standalone-captions'));
// Legal-review-checkpoint gate (Approve/Publish routes below) and the
// /items/:id/legal-review page both need this — reused, not reimplemented,
// per that file's own header comment (it must be the only place that ever
// writes content_items.legal_review_status).
const { recomputeLegalReviewStatus, RESOLVED_PETER_DECISIONS } = require(contentEnginePath('lib/legal-review'));

// ─── Config ─────────────────────────────────────────────────────────────
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[content-review] Missing environment variable: SUPABASE_SERVICE_ROLE_KEY');
  console.error('[content-review] Set this in the shared .env at the project root (see .env.example).');
  process.exit(1);
}

// Friendly display labels for the internal compliance_topics.topic_key slugs
// (e.g. "ab-1482-statewide-and-local-variation"), so Peter sees plain-English
// names on the idea submission form instead of database slugs he's never
// seen before. If a new topic is ever added to the database without being
// added here, it still shows up — just with its raw key as the label — so
// the form never silently hides a real topic.
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

function topicLabel(topicKey) {
  return TOPIC_LABELS[topicKey] || topicKey;
}

// ---------------------------------------------------------------------
// GENERATION TIMING LOG — every Claude-backed generation call (draftContent /
// reviseContent / generateCaptions / generateStandaloneCaptions) is wrapped
// with this so the Hub's own server logs always have a real timestamped
// record of how long it actually took. Logs to stdout/stderr, same as every
// other tool in this Hub.
// ---------------------------------------------------------------------
const SLOW_GENERATION_THRESHOLD_MS = 45000; // well above the typical 6-30s, well under nginx's 180s proxy timeout

async function timeGeneration(label, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    if (durationMs > SLOW_GENERATION_THRESHOLD_MS) {
      console.warn(`[content-review] SLOW: ${label} took ${durationMs}ms`);
    } else {
      console.log(`[content-review] ${label} succeeded in ${durationMs}ms`);
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    console.error(`[content-review] ${label} FAILED after ${durationMs}ms: ${err.message}`);
    throw err;
  }
}

const CONTENT_STATUSES = ['draft', 'ready_for_review', 'needs_changes', 'approved', 'published'];

// ─── Permission check — reads Neo's shared team tables ─────────────────
// Same fail-closed pattern as the other four tools' routers: any lookup
// error leaves req.contentEngineRole null rather than throwing, so a
// database hiccup denies access instead of accidentally granting it.
// Uses this file's own select() (lib/db.js) rather than a second Supabase
// client style, since every other query in this file already goes through
// it — one consistent way to talk to the database in this router, not two.
async function attachContentEngineRole(req, res, next) {
  req.contentEngineRole = null;
  req.teamMemberId = null;
  req.contentEngineMemberName = null;

  try {
    const members = await select('team_members', `select=id,full_name,is_active&auth_user_id=eq.${req.user.id}`);
    const member = members[0];
    if (!member || !member.is_active) return next();

    req.teamMemberId = member.id;
    req.contentEngineMemberName = member.full_name || null;

    const roleRows = await select(
      'team_member_tool_roles',
      `select=role&team_member_id=eq.${member.id}&tool=eq.content_engine`
    );
    req.contentEngineRole = roleRows[0] ? roleRows[0].role : null;
    next();
  } catch (err) {
    console.error('[content-review] permission lookup failed:', err.message);
    next();
  }
}

// Any granted role ('admin' or 'contributor') passes — used on every route
// in this file except the five admin-only actions below. HTML response
// (not JSON): almost every route here is a full-page navigation, so a bare
// JSON error would look broken; this renders a small page in the same
// layout instead.
function requireContentEngineAccessPage(req, res, next) {
  if (!req.contentEngineRole) {
    return res.status(403).send(
      layoutModule.layout({
        title: 'Access denied',
        user: { email: req.session.userEmail || req.user.email },
        flash: null,
        body: `
          <h2>Access denied</h2>
          <p>Your Rincon Hub account does not have access to Content Review yet. Ask an admin to grant you access.</p>
          <p><a href="/">&larr; Back to Rincon Hub</a></p>
        `,
      })
    );
  }
  next();
}

// Same check, JSON response — for the handful of routes this page's own
// client-side script calls via fetch() (chat, and every "...generate"
// endpoint an interstitial page's script POSTs to).
function requireContentEngineAccess(req, res, next) {
  if (!req.contentEngineRole) {
    return res.status(403).json({
      error: 'Your Rincon Hub account does not have access to Content Review yet. Ask an admin to grant you access.',
    });
  }
  next();
}

// The one new restriction this migration adds (Neo flagged this as
// currently missing and load-bearing): approve, reject, mark-published, a
// legal-claim decision, and saving a new brand-voice-guide version all
// require role==='admin' specifically — 'contributor' is not enough. Every
// one of these five routes is a plain <form method="POST"> submit (not a
// fetch() call), so on denial this redirects back to a sensible page with
// the same flash-message convention already used everywhere else in this
// app, rather than a bare 403.
function requireContentEngineAdminOrRedirect(buildBackPath) {
  return (req, res, next) => {
    if (req.contentEngineRole !== 'admin') {
      const backTo = typeof buildBackPath === 'function' ? buildBackPath(req) : buildBackPath;
      return res.redirect(
        `${backTo}?flash=${encodeURIComponent('That action requires admin access to Content Review. Ask an admin if you need this.')}&flashType=error`
      );
    }
    next();
  };
}

const router = express.Router();
router.use(attachContentEngineRole);

// Serves /content-review/static/generation-fetch.js and
// /content-review/static/dictation.js — two plain client-side helper
// scripts with no server dependency, copied unchanged from the standalone
// app's public/ directory. Mounted under a distinct /static sub-path
// rather than directly at /content-review itself: express.static's default
// "redirect to add a trailing slash" behavior for a directory-root request
// fires for ANY request whose path, after stripping the mount prefix, is
// empty — which would include the bare /content-review page route itself
// if the static mount used that exact same prefix (confirmed live: it
// forced an unnecessary 301 on every GET /content-review). A distinct
// sub-path avoids the collision entirely.
router.use('/content-review/static', express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// QUEUE — list of content_items, filterable by status
// ---------------------------------------------------------------------

router.get('/content-review', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const archivedFilter = req.query.status === 'archived';
    const statusFilter = !archivedFilter && CONTENT_STATUSES.includes(req.query.status) ? req.query.status : null;

    let query;
    if (archivedFilter) {
      // Show ONLY archived items, regardless of status.
      query = 'select=*&archived=eq.true&order=created_at.desc';
    } else if (statusFilter) {
      // Normal status filter — archived items stay hidden even within a status.
      query = `select=*&status=eq.${statusFilter}&archived=eq.false&order=created_at.desc`;
    } else {
      // Default queue view — hide archived items.
      query = 'select=*&archived=eq.false&order=created_at.desc';
    }
    const items = await select('content_items', query);

    // For each item, check whether any linked compliance claim needs human review.
    const itemIds = items.map((i) => i.id);
    let claimFlagsByItem = {};
    if (itemIds.length > 0) {
      const links = await select(
        'content_item_compliance_claims',
        `select=content_item_id,compliance_claims(status)&content_item_id=in.(${itemIds.join(',')})`
      );
      for (const link of links) {
        const needsReview = link.compliance_claims && link.compliance_claims.status === 'NEEDS_HUMAN_REVIEW';
        if (needsReview) {
          claimFlagsByItem[link.content_item_id] = true;
        }
      }
    }

    const filterLinks = ['<a href="/content-review"' + (!statusFilter && !archivedFilter ? ' class="active"' : '') + '>All</a>']
      .concat(
        CONTENT_STATUSES.map(
          (s) =>
            `<a href="/content-review?status=${s}"${statusFilter === s ? ' class="active"' : ''}>${s.replace(/_/g, ' ')}</a>`
        )
      )
      .concat([`<a href="/content-review?status=archived"${archivedFilter ? ' class="active"' : ''}>Archived</a>`])
      .join('\n');

    const rows = items
      .map((item) => {
        const inlineFlags = countReviewFlags(item.body);
        const claimFlag = claimFlagsByItem[item.id];
        return `
        <div class="card">
          <div class="item-title"><a href="/content-review/items/${item.id}">${escapeHtml(item.title)}</a></div>
          <div>
            <span class="badge status-${item.status}">${item.status.replace(/_/g, ' ')}</span>
            <span class="badge status-draft">${escapeHtml(item.content_type.replace(/_/g, ' '))}</span>
            ${item.politically_sensitive ? '<span class="badge sensitive">politically sensitive</span>' : ''}
            ${item.legal_review_status === 'needs_review' ? '<span class="badge legal-review-needed">Legal review needed</span>' : ''}
            ${claimFlag || inlineFlags > 0 ? '<span class="badge needs-review">needs human review</span>' : ''}
          </div>
          <div class="item-meta">
            Created ${new Date(item.created_at).toLocaleDateString()}
            ${item.author_name ? ' · ' + escapeHtml(item.author_name) : ''}
          </div>
        </div>`;
      })
      .join('\n');

    res.send(
      layoutModule.layout({
        title: 'Draft Queue',
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <h2>Content Drafts</h2>
          <div class="filters">${filterLinks}</div>
          ${items.length === 0 ? '<div class="empty-state">No drafts match this filter.</div>' : rows}
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// DETAIL / REVIEW VIEW for a single content_item
// ---------------------------------------------------------------------

router.get('/content-review/items/:id', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');

    const links = await select(
      'content_item_compliance_claims',
      `select=*,compliance_claims(*)&content_item_id=eq.${item.id}`
    );
    const sectionEdits = await select(
      'content_section_edits',
      `select=*&content_item_id=eq.${item.id}&order=created_at.desc`
    );
    const editHistory = await select(
      'content_edits',
      `select=*&content_item_id=eq.${item.id}&order=created_at.desc`
    );
    // Every message in the "Chat about this draft" card below (Peter's
    // questions/edit requests and the AI's answers/change summaries) —
    // oldest first, since that's the order a conversation reads in.
    const conversationTurns = await select(
      'content_conversation_turns',
      `select=*&content_item_id=eq.${item.id}&order=turn_number.asc`
    );

    const claimsHtml = links.length
      ? links
          .map(({ compliance_claims: c }) => {
            const needsReview = c.status === 'NEEDS_HUMAN_REVIEW';
            return `
            <details class="claim">
              <summary>
                ${escapeHtml(c.claim_key)}
                <span class="claim-confidence ${c.confidence}">${c.confidence}</span>
                ${needsReview ? '<span class="badge needs-review">NEEDS HUMAN REVIEW</span>' : ''}
              </summary>
              <div class="claim-body">
                <p><strong>Statement:</strong> ${escapeHtml(c.statement)}</p>
                <p><strong>Jurisdiction:</strong> ${escapeHtml(c.jurisdiction_scope)}</p>
                ${c.notes ? `<p><strong>Notes:</strong> ${escapeHtml(c.notes)}</p>` : ''}
                ${
                  c.evidence && c.evidence.primary && c.evidence.primary.length
                    ? '<p><strong>Source(s):</strong></p><ul>' +
                      c.evidence.primary
                        .map(
                          (e) =>
                            `<li>${escapeHtml(e.citation || e.source || '')}${
                              e.url ? ` — <a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">link</a>` : ''
                            }</li>`
                        )
                        .join('') +
                      '</ul>'
                    : ''
                }
              </div>
            </details>`;
          })
          .join('\n')
      : '<p style="color:#777;">No compliance claims linked to this item.</p>';

    const sectionEditsHtml = sectionEdits.length
      ? sectionEdits
          .map(
            (e) => `
        <div class="section-edit-block">
          <h4>${escapeHtml(e.section_label)} — edited ${new Date(e.created_at).toLocaleString()}${
              e.edited_by ? ' by ' + escapeHtml(e.edited_by) : ''
            }</h4>
          <p><strong>Before:</strong> ${escapeHtml(e.before_text)}</p>
          <p><strong>After:</strong> ${escapeHtml(e.after_text)}</p>
          ${e.reason ? `<p><strong>Reason:</strong> ${escapeHtml(e.reason)}</p>` : ''}
        </div>`
          )
          .join('\n')
      : '';

    const editHistoryHtml = editHistory.length
      ? `<div class="card" id="edit-history"><h3>Edit history</h3>` +
        editHistory
          .map((e) => {
            const metaLine = `<p style="font-size:0.85rem;color:#555;">
            <strong>${escapeHtml(e.field_changed)}</strong> changed ${new Date(e.created_at).toLocaleString()}${
              e.edited_by ? ' by ' + escapeHtml(e.edited_by) : ''
            }${e.edit_note ? ' — ' + escapeHtml(e.edit_note) : ''}
          </p>`;

            // Only 'body' and 'title' edits carry the full before/after text
            // needed for a diff — 'status' and 'archived' transitions (and
            // any row missing one side of the text) just get the metadata
            // line, exactly as before.
            const canDiff =
              (e.field_changed === 'body' || e.field_changed === 'title') &&
              e.before_text != null &&
              e.after_text != null;

            // Every entry (not just diffable ones) gets an
            // id="content-edit-<id>" wrapper so the "Chat about this
            // draft" card can link straight down to the specific edit a
            // chat-triggered revision produced, reusing this existing
            // section instead of building a second diff view.
            if (!canDiff) {
              return `<div class="edit-history-entry" id="content-edit-${e.id}">${metaLine}</div>`;
            }

            return `<div class="edit-history-entry" id="content-edit-${e.id}">
              ${metaLine}
              <div class="draft-body diff-block">${renderBodyDiff(e.before_text, e.after_text)}</div>
            </div>`;
          })
          .join('') +
        `</div>`
      : '';

    // ---------------------------------------------------------------
    // CHAT — renders content_conversation_turns oldest to newest. A
    // 'question' turn's message is the direct answer text as stored; an
    // 'edit_full_regen'/'edit_scoped' AI turn's message is already the short
    // summary lib/chat.js's summarizeEdit() (full regen) or
    // lib/scoped-edit.js's buildScopedEditSummaryMessage() (scoped edit)
    // generated — this template never re-derives or re-diffs anything, it
    // just displays what's already stored, plus a link down to the matching
    // Edit History entry above via the id="content-edit-<id>" anchors
    // already added to editHistoryHtml above.
    // ---------------------------------------------------------------
    function renderChatTurn(t) {
      const who = t.sender === 'peter' ? (t.sender_identity || 'You') : 'AI';
      const when = new Date(t.created_at).toLocaleString();
      const isEditTurn = t.sender === 'ai' && t.turn_type !== 'question' && t.resulting_content_edit_id;
      const isScoped = t.turn_type === 'edit_scoped';
      const editBits = isEditTurn
        ? `<span class="badge ${isScoped ? 'status-ready_for_review' : 'status-approved'} chat-badge">${
            isScoped ? 'Small edit applied' : 'Draft revised'
          }</span>
           <a class="chat-edit-link" href="#content-edit-${t.resulting_content_edit_id}">See this change in Edit History &darr;</a>`
        : '';
      return `
        <div class="chat-turn ${t.sender === 'peter' ? 'peter' : 'ai'}">
          <span class="chat-meta">${escapeHtml(who)} &middot; ${when}</span>
          <div class="chat-text">${escapeHtml(t.message)}</div>
          ${editBits}
        </div>`;
    }

    const chatTurnsHtml = conversationTurns.length
      ? conversationTurns.map(renderChatTurn).join('\n')
      : '<p class="empty-state" id="chat-empty-state">No messages yet — ask a question about this draft, or describe a change you want, below.</p>';

    // Passed to the inline script below so it knows where to POST and how to
    // label the current user's live-appended turns — JSON.stringify escapes
    // everything safely; "</" is additionally escaped so a value can never
    // accidentally close this inline <script> tag early (same defensive
    // pattern already used for the /ideas/new and /social/new payloads).
    const chatBootstrap = JSON.stringify({
      itemId: item.id,
      senderIdentity: req.session.userEmail,
    }).replace(/<\//g, '<\\/');

    const chatCardHtml = `
      <div class="card">
        <h3>Chat about this draft</h3>
        <p style="font-size:0.85rem;color:#666;">
          Ask a question and get a direct answer, or ask for a change and the
          AI will revise the whole draft — same as "Request Changes" above,
          just started from a chat message. Every message here is saved.
        </p>
        <div id="chat-log" class="chat-log">
          ${chatTurnsHtml}
        </div>
        <div id="chat-thinking" class="chat-thinking" style="display:none;">
          <div class="spinner chat-spinner"></div>
          <span id="chat-thinking-text">Thinking&hellip;</span>
        </div>
        <div id="chat-error" class="flash error" style="display:none;"></div>
        <form id="chat-form" class="inline-form">
          <label for="chat-message">Message</label>
          <textarea id="chat-message" name="message" required data-dictation="true" placeholder="Ask a question about this draft, or describe a change you want..."></textarea>
          <div class="actions">
            <button type="submit" id="chat-send-btn" class="btn-changes">Send</button>
          </div>
        </form>
      </div>
      <script>
        (function () {
          var CHAT_CONFIG = ${chatBootstrap};
          var chatForm = document.getElementById('chat-form');
          var chatInput = document.getElementById('chat-message');
          var chatSendBtn = document.getElementById('chat-send-btn');
          var chatLog = document.getElementById('chat-log');
          var chatThinking = document.getElementById('chat-thinking');
          var chatThinkingText = document.getElementById('chat-thinking-text');
          var chatError = document.getElementById('chat-error');

          function escapeHtmlClient(str) {
            return String(str)
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;');
          }

          function appendTurn(sender, who, message) {
            var emptyState = document.getElementById('chat-empty-state');
            if (emptyState) emptyState.style.display = 'none';
            var div = document.createElement('div');
            div.className = 'chat-turn ' + sender;
            var when = new Date().toLocaleString();
            div.innerHTML =
              '<span class="chat-meta">' + escapeHtmlClient(who) + ' &middot; ' + when + '</span>' +
              '<div class="chat-text">' + escapeHtmlClient(message) + '</div>';
            chatLog.appendChild(div);
            chatLog.scrollTop = chatLog.scrollHeight;
          }

          function setBusy(busy) {
            chatInput.disabled = busy;
            chatSendBtn.disabled = busy;
          }

          chatForm.addEventListener('submit', function (e) {
            e.preventDefault();
            var message = chatInput.value.trim();
            if (!message) return;

            setBusy(true);
            chatError.style.display = 'none';
            chatThinkingText.textContent = 'Thinking\\u2026';
            chatThinking.style.display = 'flex';

            var slowNoticeTimer = setTimeout(function () {
              chatThinkingText.textContent = "Still working \\u2014 if this turns into a full draft revision it can take 20-90+ seconds. Please don't close this tab.";
            }, 8000);

            generationFetchWithTimeout('/content-review/items/' + CHAT_CONFIG.itemId + '/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: message }),
            })
              .then(function (result) {
                clearTimeout(slowNoticeTimer);
                if (!result.ok) {
                  throw new Error((result.data && result.data.error) || 'Something went wrong processing that message.');
                }
                var data = result.data;
                if (data.intent === 'EDIT') {
                  var isScoped = data.aiTurn && data.aiTurn.turn_type === 'edit_scoped';
                  var flashText = isScoped
                    ? 'Small, targeted edit applied — review the updated draft below.'
                    : 'Chat edit applied — the full draft was revised. Review the updated draft below.';
                  window.location.href = '/content-review/items/' + CHAT_CONFIG.itemId + '?flash=' + encodeURIComponent(flashText);
                  return;
                }
                appendTurn('peter', CHAT_CONFIG.senderIdentity, data.peterTurn.message);
                appendTurn('ai', 'AI', data.aiTurn.message);
                chatInput.value = '';
                chatThinking.style.display = 'none';
                setBusy(false);
                chatInput.focus();
              })
              .catch(function (err) {
                clearTimeout(slowNoticeTimer);
                chatThinking.style.display = 'none';
                setBusy(false);
                var suffix = err.isTimeout ? '' : ' Your message may already be saved \\u2014 refresh the page to check before sending it again.';
                chatError.textContent = err.message + suffix;
                chatError.style.display = 'block';
              });
          });

          chatInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (chatForm.requestSubmit) {
                chatForm.requestSubmit();
              } else {
                chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
              }
            }
          });
        })();
      </script>
    `;

    // FAQ schema "copy this into your page" box — only shown when this item
    // has a generated FAQPage JSON-LD block.
    let faqSchemaHtml = '';
    if (item.faq_schema) {
      try {
        const faqObject =
          typeof item.faq_schema === 'string' ? JSON.parse(item.faq_schema) : item.faq_schema;
        const prettyJson = JSON.stringify(faqObject, null, 2);
        const scriptBlock = `<script type="application/ld+json">\n${prettyJson}\n</script>`;
        faqSchemaHtml = `
          <div class="card">
            <h3>FAQ code for your page (SEO)</h3>
            <p style="font-size:0.85rem;color:#666;">
              This is code, not something readers see — when you publish
              this post, paste the block below into your page's HTML,
              usually in a "custom code" or "header scripts" section your
              site builder provides.
            </p>
            <textarea id="faq-schema-textarea" readonly style="min-height:200px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.85rem;">${escapeHtml(scriptBlock)}</textarea>
          </div>
          <script>
            (function () {
              var el = document.getElementById('faq-schema-textarea');
              if (el) el.addEventListener('click', function () { this.select(); });
            })();
          </script>
        `;
      } catch (e) {
        // Malformed JSON in the database shouldn't break the whole page —
        // just skip the box rather than crashing the draft detail view.
        console.error(`Could not parse faq_schema for item ${item.id}:`, e);
      }
    }

    // Publish state — either the "mark as published" form (admin only —
    // see requireContentEngineAdminOrRedirect on the route below) or a
    // plain link to the already-recorded live URL. Nothing here calls any
    // external publishing API; this only records a URL someone already
    // published manually.
    const publishHtml = item.published_url
      ? `
      <div class="card">
        <h3>Published</h3>
        <p style="font-size:0.85rem;color:#666;">This post is marked as published at:</p>
        <p><a href="${escapeHtml(item.published_url)}" target="_blank" rel="noopener">${escapeHtml(item.published_url)}</a></p>
      </div>
      `
      : req.contentEngineRole === 'admin'
      ? `
      <div class="card">
        <h3>Mark as Published</h3>
        <p style="font-size:0.85rem;color:#666;">
          Once this post is actually live on the site, paste its web
          address here and save — this only records that it's published;
          it does not publish anything for you.
        </p>
        <form method="POST" action="/content-review/items/${item.id}/publish" class="inline-form">
          <label for="published_url">Live URL</label>
          <input type="text" id="published_url" name="published_url" placeholder="https://www.rinconmanagement.com/blog/...">
          <div class="actions">
            <button type="submit" class="btn-approve">Mark as Published</button>
          </div>
        </form>
      </div>
      `
      : `
      <div class="card">
        <h3>Published</h3>
        <p class="item-meta">Marking a post as published requires admin access to Content Review.</p>
      </div>
      `;

    // Whole-document edit form (title / body / meta_description) — open to
    // any team member with content_engine access (contributor or admin);
    // this is editing a draft, not deciding its fate.
    const wholeDocEditForm = `
      <div class="card">
        <h3>Edit this draft</h3>
        <form method="POST" action="/content-review/items/${item.id}/edit" class="inline-form">
          <label for="title">Title</label>
          <input type="text" id="title" name="title" value="${escapeHtml(item.title)}">
          <label for="meta_description">Meta description (SEO summary, optional)</label>
          <textarea id="meta_description" name="meta_description">${escapeHtml(item.meta_description || '')}</textarea>
          <label for="seo_title">SEO title (optional)</label>
          <div class="helper-text">
            The short, literal title search engines show in results
            (usually 55-60 characters) — keyword-forward, not necessarily
            catchy. This is separate from the headline above, which stays
            the on-page title in Rincon's normal voice.
          </div>
          <input type="text" id="seo_title" name="seo_title" value="${escapeHtml(item.seo_title || '')}">
          <label for="body">Full draft text</label>
          <textarea id="body" name="body" style="min-height:300px;">${escapeHtml(item.body || '')}</textarea>
          <div class="actions">
            <button type="submit" class="btn-secondary">Save edits</button>
          </div>
        </form>
      </div>
    `;

    // Section-level inline editor — only for politically_sensitive items,
    // open to contributor or admin (explicitly named as such in this
    // build's spec).
    const sectionEditForm = item.politically_sensitive
      ? `
      <div class="card">
        <h3>Section-level edit (politically sensitive content)</h3>
        <p style="font-size:0.85rem;color:#666;">
          Use this for civic/political content where you want to fix one
          paragraph or quote without rewriting the whole piece. This is
          logged separately so there's a clear record of what was changed
          and why.
        </p>
        <form method="POST" action="/content-review/items/${item.id}/section-edit" class="inline-form">
          <label for="section_label">Which section? (e.g. "paragraph 3", "quote from council member")</label>
          <input type="text" id="section_label" name="section_label" required>
          <label for="before_text">Original text of that section</label>
          <textarea id="before_text" name="before_text" required></textarea>
          <label for="after_text">Your replacement text</label>
          <textarea id="after_text" name="after_text" required></textarea>
          <label for="reason">Reason for the change (tone, accuracy, neutrality, etc.)</label>
          <input type="text" id="reason" name="reason">
          <div class="actions">
            <button type="submit" class="btn-changes">Save section edit</button>
          </div>
        </form>
        ${sectionEditsHtml}
      </div>
      `
      : '';

    // Decision card — Approve/Reject are admin-only (server-side enforced
    // on the routes below via requireContentEngineAdminOrRedirect); hidden
    // here for a non-admin so they never see a button that would just
    // redirect back with a "requires admin access" flash. Request Changes
    // stays open to contributor or admin.
    const decisionButtonsHtml =
      req.contentEngineRole === 'admin'
        ? `
            <div class="actions">
              <form method="POST" action="/content-review/items/${item.id}/approve" style="display:inline;">
                <button type="submit" class="btn-approve" ${item.legal_review_status === 'needs_review' ? 'disabled' : ''}>Approve</button>
              </form>
              <form method="POST" action="/content-review/items/${item.id}/reject" id="reject-form-${item.id}" style="display:inline;">
                <button type="submit" class="btn-reject">Reject</button>
              </form>
            </div>
            ${
              item.legal_review_status === 'needs_review'
                ? `<p style="font-size:0.85rem;color:var(--red);margin-top:6px;">
                    Approve is disabled until all legal claims on this draft are reviewed —
                    <a href="/content-review/items/${item.id}/legal-review">review legal claims &rarr;</a>
                  </p>`
                : ''
            }
            <script>
              (function () {
                var form = document.getElementById('reject-form-${item.id}');
                if (form) {
                  form.addEventListener('submit', function (e) {
                    if (!confirm('Reject this draft?')) e.preventDefault();
                  });
                }
              })();
            </script>
          `
        : `<p class="item-meta">Approving and rejecting require admin access to Content Review.</p>`;

    res.send(
      layoutModule.layout({
        title: item.title,
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <p><a href="/content-review">&larr; Back to queue</a></p>
          <h2>${escapeHtml(item.title)}</h2>
          <div>
            <span class="badge status-${item.status}">${item.status.replace(/_/g, ' ')}</span>
            <span class="badge status-draft">${escapeHtml(item.content_type.replace(/_/g, ' '))}</span>
            ${item.politically_sensitive ? '<span class="badge sensitive">politically sensitive</span>' : ''}
            ${item.archived ? '<span class="badge sensitive">archived</span>' : ''}
          </div>

          <div class="card">
            <h3>Draft text</h3>
            <div class="draft-body">${renderDraftBody(item.body)}</div>
          </div>

          ${faqSchemaHtml}

          <div class="card">
            <h3>Archive</h3>
            <p style="font-size:0.85rem;color:#666;">
              ${
                item.archived
                  ? 'This draft is archived and hidden from the main queue. Unarchiving brings it back to the normal view — this does not change its approval status.'
                  : 'Archiving hides this draft from the main queue without changing its approval status. You can find it later under the "Archived" filter and bring it back any time.'
              }
            </p>
            <div class="actions">
              ${
                item.archived
                  ? `<form method="POST" action="/content-review/items/${item.id}/unarchive" style="display:inline;">
                      <button type="submit" class="btn-secondary">Unarchive</button>
                    </form>`
                  : `<form method="POST" action="/content-review/items/${item.id}/archive" style="display:inline;">
                      <button type="submit" class="btn-secondary">Archive</button>
                    </form>`
              }
            </div>
          </div>

          <div class="card">
            <h3>Legal claims cited (${links.length})</h3>
            ${claimsHtml}
          </div>

          ${
            item.legal_review_status === 'needs_review'
              ? `<div class="card legal-review-alert">
                  <h3>Legal review needed</h3>
                  <p style="font-size:0.9rem;color:#444;">
                    This draft has a legal claim the AI researched and sourced
                    itself — it's not yet part of Rincon's verified legal
                    knowledge base. It can't be approved or published until
                    every claim below has an admin's decision recorded, even
                    if Mason's automatic review already looked at it.
                  </p>
                  <p>
                    <a href="/content-review/items/${item.id}/legal-review" class="btn-changes" style="display:inline-block;text-decoration:none;">Review legal claims &rarr;</a>
                  </p>
                </div>`
              : ''
          }

          <div class="card">
            <h3>Decision</h3>
            ${decisionButtonsHtml}
            <form method="POST" action="/content-review/items/${item.id}/request-changes" class="inline-form">
              <label for="comment">Request changes — describe what needs to change (required, goes back to the writer)</label>
              <textarea id="comment" name="comment" required data-dictation="true"></textarea>
              <p style="font-size:0.85rem;color:#666;margin-top:6px;">
                Submitting will save this note and immediately ask the AI to rewrite the
                draft to address it (yours plus any earlier feedback on this item) — it
                will not invent new legal facts, only use what's already grounded in this
                draft's linked compliance claims, or flag anything that needs new legal
                grounding. Takes about 20-30 seconds; nothing is published automatically.
              </p>
              <div class="actions">
                <button type="submit" class="btn-changes">Request Changes &amp; Revise with AI</button>
              </div>
            </form>
          </div>

          ${chatCardHtml}

          ${publishHtml}

          ${sectionEditForm}
          ${wholeDocEditForm}
          ${editHistoryHtml}

          ${
            item.content_type === 'blog_post' && item.status === 'approved'
              ? `<div class="card">
                  <h3>Social captions</h3>
                  <p><a href="/content-review/items/${item.id}/captions" class="btn btn-secondary">Review social captions for this post &rarr;</a></p>
                  <p style="font-size:0.85rem;color:#666;">
                    Need new captions instead? Generating replaces nothing — it
                    just adds 3 new pending captions (Facebook, LinkedIn,
                    Instagram) for you to review.
                  </p>
                  <div class="actions">
                    <a href="/content-review/items/${item.id}/captions/generate" class="btn-approve" style="display:inline-block;text-decoration:none;">Generate Social Captions</a>
                  </div>
                </div>`
              : ''
          }

          <div class="safety-note">
            This page only changes the status field on this draft in the database.
            Nothing here posts, publishes, or sends anything anywhere — getting
            approved content live is a manual step someone does outside this app.
          </div>
          <script src="/content-review/static/generation-fetch.js"></script>
          <script src="/content-review/static/dictation.js"></script>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// ACTIONS: approve / reject / request-changes — status changes ONLY
// ---------------------------------------------------------------------

router.post(
  '/content-review/items/:id/approve',
  requireContentEngineAdminOrRedirect((req) => `/content-review/items/${req.params.id}`),
  async (req, res, next) => {
    try {
      // Hard block — checked server-side so this can't be bypassed by posting
      // directly to this route, not just by disabling the Approve button in
      // the UI (see the matching check on POST .../publish below).
      // Refuses and leaves status untouched; does not change anything.
      const item = await selectOne('content_items', req.params.id);
      if (!item) return res.status(404).send('Draft not found.');
      if (item.legal_review_status === 'needs_review') {
        return res.redirect(
          `/content-review/items/${req.params.id}?flash=${encodeURIComponent('This draft has legal claims pending review — resolve them before approving.')}&flashType=error`
        );
      }

      const updated = await updateOne('content_items', req.params.id, { status: 'approved' });
      if (!updated) return res.status(404).send('Draft not found.');
      res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('Draft approved.')}`);
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/content-review/items/:id/reject',
  requireContentEngineAdminOrRedirect((req) => `/content-review/items/${req.params.id}`),
  async (req, res, next) => {
    try {
      // Rejected drafts go back to 'draft' status (schema has no explicit
      // 'rejected' status for content_items — only draft/ready_for_review/
      // needs_changes/approved/published). We log the rejection as an edit
      // note so there's a record of the decision.
      const updated = await updateOne('content_items', req.params.id, { status: 'draft' });
      if (!updated) return res.status(404).send('Draft not found.');
      await insert('content_edits', {
        content_item_id: req.params.id,
        edited_by: req.session.userEmail,
        field_changed: 'status',
        before_text: null,
        after_text: 'rejected (returned to draft)',
        edit_note: 'Rejected via review page.',
      });
      res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('Draft rejected and sent back to draft status.')}&flashType=error`);
    } catch (err) {
      next(err);
    }
  }
);

// Request Changes does two things in one action: log the feedback, then
// immediately revise the draft with AI using that feedback (plus any prior
// rounds already on this item). Open to contributor or admin — this is
// requesting an edit, not a final approve/reject decision.
router.post('/content-review/items/:id/request-changes', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const { comment } = req.body;
    if (!comment || !comment.trim()) {
      return res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('A comment is required to request changes.')}&flashType=error`);
    }
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');

    const updated = await updateOne('content_items', req.params.id, { status: 'needs_changes' });
    if (!updated) return res.status(404).send('Draft not found.');
    await insert('content_edits', {
      content_item_id: req.params.id,
      edited_by: req.session.userEmail,
      field_changed: 'status',
      before_text: null,
      after_text: 'needs_changes',
      edit_note: comment.trim(),
    });

    res.send(
      layoutModule.layout({
        title: 'Revising with AI...',
        user: { email: req.session.userEmail },
        flash: null,
        body: `
          <div class="generating-wrap">
            <div class="spinner"></div>
            <h2>Revising with AI&hellip;</h2>
            <p style="color:#666;">Your feedback was saved. Now rewriting the draft to address it — this usually takes 20-30 seconds. Please don't close this tab.</p>
            <div id="gen-error" class="flash error" style="display:none;"></div>
          </div>
          <form id="retry-form" method="GET" action="/content-review/items/${item.id}" style="display:none;"></form>
          <script src="/content-review/static/generation-fetch.js"></script>
          <script>
            (function () {
              generationFetchWithTimeout('/content-review/items/${item.id}/request-changes/generate', { method: 'POST' })
                .then(function (result) {
                  if (result.ok && result.data.redirect) {
                    window.location.href = result.data.redirect;
                  } else {
                    throw new Error((result.data && result.data.error) || 'Something went wrong revising the draft.');
                  }
                })
                .catch(function (err) {
                  document.querySelector('.spinner').style.display = 'none';
                  var errBox = document.getElementById('gen-error');
                  var suffix = err.isTimeout ? '' : ' — your feedback was saved, but the automatic rewrite failed. Go back to the draft — it is in Needs Changes status and can be revised again.';
                  errBox.textContent = err.message + suffix;
                  errBox.style.display = 'block';
                });
            })();
          </script>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

// Does the actual (slow) revision call once feedback has already been
// logged by POST .../request-changes above. Same reviseContent() call the
// old standalone app used — it re-reads all accumulated feedback from
// content_edits itself.
router.post('/content-review/items/:id/request-changes/generate', requireContentEngineAccess, async (req, res) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).json({ error: 'Draft not found.' });
    if (item.status !== 'needs_changes') {
      return res.status(400).json({ error: 'This draft is no longer in needs_changes status.' });
    }

    const { contentItem } = await timeGeneration(
      `reviseContent item=${item.id}`,
      () => reviseContent({
        contentItemId: item.id,
        currentTitle: item.title,
        currentBody: item.body,
      })
    );

    res.json({
      redirect: `/content-review/items/${contentItem.id}?flash=${encodeURIComponent('Feedback saved and draft revised — review the updated version below.')}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Revision failed. This is usually a temporary issue — please try again.' });
  }
});

// ---------------------------------------------------------------------
// ARCHIVE / UNARCHIVE — hides/shows an item from the default queue view.
// Independent of approval status: archiving never touches the `status`
// field, only `archived`. Open to contributor or admin.
// ---------------------------------------------------------------------

router.post('/content-review/items/:id/archive', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const updated = await updateOne('content_items', req.params.id, { archived: true });
    if (!updated) return res.status(404).send('Draft not found.');
    await insert('content_edits', {
      content_item_id: req.params.id,
      edited_by: req.session.userEmail,
      field_changed: 'archived',
      before_text: 'false',
      after_text: 'true',
      edit_note: 'Archived via review page.',
    });
    res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('Draft archived — hidden from the main queue.')}`);
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/items/:id/unarchive', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const updated = await updateOne('content_items', req.params.id, { archived: false });
    if (!updated) return res.status(404).send('Draft not found.');
    await insert('content_edits', {
      content_item_id: req.params.id,
      edited_by: req.session.userEmail,
      field_changed: 'archived',
      before_text: 'true',
      after_text: 'false',
      edit_note: 'Unarchived via review page.',
    });
    res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('Draft unarchived — back in the main queue.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// PUBLISH — one-time action that records the live URL once a post has
// actually gone out (a manual step someone does outside this app). Admin
// only ("mark-published"). Never calls any external publishing API.
// ---------------------------------------------------------------------

router.post(
  '/content-review/items/:id/publish',
  requireContentEngineAdminOrRedirect((req) => `/content-review/items/${req.params.id}`),
  async (req, res, next) => {
    try {
      const item = await selectOne('content_items', req.params.id);
      if (!item) return res.status(404).send('Draft not found.');

      // Same hard block as POST .../approve above — server-side, so
      // posting directly to this route can't bypass it either. Refuses and
      // leaves status/published_url untouched.
      if (item.legal_review_status === 'needs_review') {
        return res.redirect(
          `/content-review/items/${req.params.id}?flash=${encodeURIComponent('This draft has legal claims pending review — resolve them before publishing.')}&flashType=error`
        );
      }

      const publishedUrl = (req.body.published_url || '').trim();
      if (!publishedUrl) {
        return res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('Enter the live URL to mark this as published.')}&flashType=error`);
      }
      if (!/^https?:\/\//i.test(publishedUrl)) {
        return res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('That does not look like a valid web address — it should start with http:// or https://.')}&flashType=error`);
      }

      let updated;
      try {
        updated = await updateOne('content_items', req.params.id, {
          status: 'published',
          published_url: publishedUrl,
        });
      } catch (updateErr) {
        // published_url has a UNIQUE constraint (uq_content_items_published_url) —
        // if a duplicate URL is pasted, PostgREST rejects the write with a
        // 23505 "duplicate key" error. Catch just that specific case and
        // give a friendly explanation instead of a generic error page.
        const isDuplicateUrl =
          updateErr.message &&
          (updateErr.message.includes('23505') ||
            updateErr.message.includes('duplicate key value violates unique constraint'));
        if (isDuplicateUrl) {
          return res.redirect(
            `/content-review/items/${req.params.id}?flash=${encodeURIComponent('That web address is already linked to a different post — double check the URL, or use a different one.')}&flashType=error`
          );
        }
        throw updateErr;
      }
      if (!updated) return res.status(404).send('Draft not found.');

      await insert('content_edits', [
        {
          content_item_id: req.params.id,
          edited_by: req.session.userEmail,
          field_changed: 'status',
          before_text: item.status,
          after_text: 'published',
          edit_note: 'Marked as published via review page.',
        },
        {
          content_item_id: req.params.id,
          edited_by: req.session.userEmail,
          field_changed: 'published_url',
          before_text: item.published_url,
          after_text: publishedUrl,
          edit_note: 'Marked as published via review page.',
        },
      ]);

      res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('Marked as published.')}`);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// LEGAL REVIEW — the page the "Legal review needed" card above links to.
// Lists every legal_claim_reviews row for this article and lets an admin
// record a decision on each one. Viewing is open to contributor or admin;
// recording a decision is admin-only ("any legal-claim decision" — see
// requireContentEngineAdminOrRedirect on the decide route below).
// ---------------------------------------------------------------------

const LEGAL_DECISION_LABELS = {
  approved_as_is: 'Approved as-is',
  approved_with_edit: 'Approved with edit',
  removed_from_draft: 'Removed from draft',
  consulting_attorney: 'Consulting an attorney',
};

const MASON_FINDING_LABELS = {
  CONFIRMED: 'Confirmed',
  NEEDS_SOURCE_CHECK: 'Needs source check',
  FLAG_FOR_ATTORNEY: 'Flag for attorney',
  REJECT: 'Reject',
};

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

router.get('/content-review/items/:id/legal-review', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');

    const claims = await select(
      'legal_claim_reviews',
      `select=*&content_item_id=eq.${item.id}&order=created_at.asc`
    );

    const sortedClaims = claims.slice().sort((a, b) => {
      const aResolved = RESOLVED_PETER_DECISIONS.includes(a.peter_decision) ? 1 : 0;
      const bResolved = RESOLVED_PETER_DECISIONS.includes(b.peter_decision) ? 1 : 0;
      return aResolved - bResolved;
    });

    const isAdmin = req.contentEngineRole === 'admin';

    const claimsHtml = sortedClaims.length
      ? sortedClaims
          .map((c) => {
            const isResolved = RESOLVED_PETER_DECISIONS.includes(c.peter_decision);

            const masonHtml = c.mason_finding
              ? `<p style="margin-top:10px;">
                  <span class="badge mason-finding-${c.mason_finding.toLowerCase().replace(/_/g, '-')}">${escapeHtml(MASON_FINDING_LABELS[c.mason_finding] || c.mason_finding)}</span>
                </p>
                ${c.mason_note ? `<p style="font-size:0.9rem;color:#444;">${escapeHtml(c.mason_note)}</p>` : ''}`
              : `<p style="font-size:0.9rem;color:#777;font-style:italic;margin-top:10px;">Mason's review is still in progress.</p>`;

            const decidedHtml = c.peter_decision
              ? `<p style="font-size:0.85rem;color:#555;">
                  Current decision: <strong>${escapeHtml(LEGAL_DECISION_LABELS[c.peter_decision] || c.peter_decision)}</strong>
                  ${c.decided_by ? ' by ' + escapeHtml(c.decided_by) : ''}${c.decided_at ? ' on ' + new Date(c.decided_at).toLocaleString() : ''}
                  ${c.peter_edited_text ? `<br>Edited text: &ldquo;${escapeHtml(c.peter_edited_text)}&rdquo;` : ''}
                </p>`
              : '';

            const sourceHtml = isHttpUrl(c.source_url)
              ? `<a href="${escapeHtml(c.source_url)}" target="_blank" rel="noopener">${escapeHtml(c.source_url)}</a>`
              : escapeHtml(c.source_url || 'No source provided.');

            const decisionFormHtml = isAdmin
              ? `<form method="POST" action="/content-review/items/${item.id}/legal-review/${c.id}/decide" class="inline-form">
                <label for="peter_decision-${c.id}">Your decision</label>
                <select id="peter_decision-${c.id}" name="peter_decision" class="legal-decision-select" data-review-id="${c.id}" required>
                  <option value="" disabled${!c.peter_decision ? ' selected' : ''}>Choose one&hellip;</option>
                  <option value="approved_as_is"${c.peter_decision === 'approved_as_is' ? ' selected' : ''}>Approve as-is</option>
                  <option value="approved_with_edit"${c.peter_decision === 'approved_with_edit' ? ' selected' : ''}>Approve with my edit</option>
                  <option value="removed_from_draft"${c.peter_decision === 'removed_from_draft' ? ' selected' : ''}>Remove from draft</option>
                  <option value="consulting_attorney"${c.peter_decision === 'consulting_attorney' ? ' selected' : ''}>I'm consulting an attorney</option>
                </select>

                <div id="edit-text-wrap-${c.id}" style="display:${c.peter_decision === 'approved_with_edit' ? 'block' : 'none'};">
                  <label for="peter_edited_text-${c.id}">Your replacement text</label>
                  <textarea id="peter_edited_text-${c.id}" name="peter_edited_text">${escapeHtml(c.peter_edited_text || '')}</textarea>
                </div>

                <div class="actions">
                  <button type="submit" class="btn-approve">Save decision</button>
                </div>
              </form>`
              : `<p class="item-meta">Recording a decision requires admin access to Content Review.</p>`;

            return `
            <div class="card legal-claim-card ${isResolved ? 'resolved' : 'unresolved'}">
              <div>
                <span class="badge ${isResolved ? 'status-approved' : 'needs-review'}">${isResolved ? 'Resolved' : 'Unresolved'}</span>
              </div>
              <p><strong>Claim:</strong> ${escapeHtml(c.claim_text)}</p>
              ${c.claim_context && c.claim_context !== c.claim_text ? `<p><strong>Context:</strong> ${escapeHtml(c.claim_context)}</p>` : ''}
              <p><strong>Source:</strong> ${sourceHtml}</p>
              <p><strong>Jurisdiction:</strong> ${escapeHtml(c.jurisdiction_scope)}</p>

              <h4 style="margin-bottom:0;">Mason's review</h4>
              ${masonHtml}

              ${decidedHtml}

              ${decisionFormHtml}
            </div>`;
          })
          .join('\n')
      : '<div class="empty-state">No legal claims linked to this article.</div>';

    res.send(
      layoutModule.layout({
        title: `Legal review — ${item.title}`,
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <p><a href="/content-review/items/${item.id}">&larr; Back to draft</a></p>
          <h2>Legal review — ${escapeHtml(item.title)}</h2>
          <p style="font-size:0.9rem;color:#666;">
            These are legal claims the AI researched and sourced itself while
            writing this draft — they are not part of Rincon's pre-verified
            legal knowledge base, so each one needs an admin's explicit
            decision before the draft can be approved or published. Mason's
            automatic review below is his judgment on the claim and its
            source; it is an input to that decision, not a substitute for it.
          </p>
          ${claimsHtml}
          <div class="safety-note">
            Saving a decision here only updates this claim's review row and
            this draft's legal review status. Nothing here posts, publishes,
            or sends anything anywhere.
          </div>
          <script>
            document.querySelectorAll('.legal-decision-select').forEach(function (select) {
              function sync() {
                var wrap = document.getElementById('edit-text-wrap-' + select.dataset.reviewId);
                if (wrap) wrap.style.display = select.value === 'approved_with_edit' ? 'block' : 'none';
              }
              select.addEventListener('change', sync);
              sync();
            });
          </script>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post(
  '/content-review/items/:id/legal-review/:reviewId/decide',
  requireContentEngineAdminOrRedirect((req) => `/content-review/items/${req.params.id}/legal-review`),
  async (req, res, next) => {
    try {
      const { id, reviewId } = req.params;

      const item = await selectOne('content_items', id);
      if (!item) return res.status(404).send('Draft not found.');

      const review = await selectOne('legal_claim_reviews', reviewId);
      if (!review || review.content_item_id !== id) {
        return res.status(404).send('Legal claim review not found on this draft.');
      }

      const { peter_decision } = req.body;
      const peterEditedText = typeof req.body.peter_edited_text === 'string' ? req.body.peter_edited_text.trim() : '';

      if (!Object.prototype.hasOwnProperty.call(LEGAL_DECISION_LABELS, peter_decision)) {
        return res.redirect(`/content-review/items/${id}/legal-review?flash=${encodeURIComponent('Choose a decision before saving.')}&flashType=error`);
      }
      if (peter_decision === 'approved_with_edit' && !peterEditedText) {
        return res.redirect(`/content-review/items/${id}/legal-review?flash=${encodeURIComponent('Enter your replacement text for "Approve with my edit."')}&flashType=error`);
      }

      const patch = {
        peter_decision,
        peter_edited_text: peter_decision === 'approved_with_edit' ? peterEditedText : null,
        decided_by: req.session.userEmail,
        decided_at: new Date().toISOString(),
      };
      await updateOne('legal_claim_reviews', reviewId, patch);

      await insert('content_edits', {
        content_item_id: id,
        edited_by: req.session.userEmail,
        field_changed: 'legal_review',
        before_text: review.peter_decision,
        after_text: peter_decision,
        edit_note: `Claim: "${review.claim_text}"${patch.peter_edited_text ? ` — edited text: "${patch.peter_edited_text}"` : ''}`,
      });

      // Recompute, don't reimplement — the one function allowed to write
      // content_items.legal_review_status (content-engine/lib/legal-review.js).
      await recomputeLegalReviewStatus(id);

      res.redirect(`/content-review/items/${id}/legal-review?flash=${encodeURIComponent('Decision saved.')}`);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// Whole-document edit (title / body / meta_description) -> content_edits
// ---------------------------------------------------------------------

router.post('/content-review/items/:id/edit', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');

    const { title, body, meta_description, seo_title } = req.body;
    const changes = [];
    const patch = {};

    if (title !== undefined && title !== item.title) {
      changes.push({ field: 'title', before: item.title, after: title });
      patch.title = title;
    }
    if (body !== undefined && body !== item.body) {
      changes.push({ field: 'body', before: item.body, after: body });
      patch.body = body;
    }
    if (meta_description !== undefined && meta_description !== (item.meta_description || '')) {
      changes.push({ field: 'meta_description', before: item.meta_description, after: meta_description });
      patch.meta_description = meta_description;
    }
    if (seo_title !== undefined && seo_title !== (item.seo_title || '')) {
      changes.push({ field: 'seo_title', before: item.seo_title, after: seo_title });
      patch.seo_title = seo_title;
    }

    if (Object.keys(patch).length > 0) {
      await updateOne('content_items', req.params.id, patch);
      await insert(
        'content_edits',
        changes.map((c) => ({
          content_item_id: req.params.id,
          edited_by: req.session.userEmail,
          field_changed: c.field,
          before_text: c.before,
          after_text: c.after,
          edit_note: 'Edited via review page.',
        }))
      );
    }

    res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('Edits saved.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Section-level edit (politically_sensitive items only) -> content_section_edits
// ---------------------------------------------------------------------

router.post('/content-review/items/:id/section-edit', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');
    if (!item.politically_sensitive) {
      return res.status(400).send('Section-level editing is only available for politically sensitive content.');
    }

    const { section_label, before_text, after_text, reason } = req.body;
    if (!section_label || !before_text || !after_text) {
      return res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('Section, before text, and after text are all required.')}&flashType=error`);
    }

    await insert('content_section_edits', {
      content_item_id: req.params.id,
      section_label,
      edited_by: req.session.userEmail,
      before_text,
      after_text,
      reason: reason || null,
    });

    if (item.body && item.body.includes(before_text)) {
      const newBody = item.body.replace(before_text, after_text);
      await updateOne('content_items', req.params.id, { body: newBody });
      await insert('content_edits', {
        content_item_id: req.params.id,
        edited_by: req.session.userEmail,
        field_changed: 'body',
        before_text: item.body,
        after_text: newBody,
        edit_note: `Section edit applied: ${section_label}${reason ? ' — ' + reason : ''}`,
      });
    }

    res.redirect(`/content-review/items/${req.params.id}?flash=${encodeURIComponent('Section edit saved.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// CHAT — a real back-and-forth conversation on a draft. Open to
// contributor or admin — explicitly named as such in this build's spec.
// ---------------------------------------------------------------------

router.post('/content-review/items/:id/chat', requireContentEngineAccess, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'A message is required.' });
    }

    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).json({ error: 'Draft not found.' });

    const result = await timeGeneration(`handleChatMessage item=${item.id}`, () =>
      handleChatMessage({
        contentItemId: item.id,
        message,
        senderIdentity: req.session.userEmail,
      })
    );

    res.json({
      intent: result.intent,
      peterTurn: result.peterTurn,
      aiTurn: result.aiTurn,
      contentItem: {
        id: result.contentItem.id,
        title: result.contentItem.title,
        body: result.contentItem.body,
        status: result.contentItem.status,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong processing that message. Please try again.' });
  }
});

// ---------------------------------------------------------------------
// SUBMIT AN IDEA — self-serve draft request, no CLI needed. Open to
// contributor or admin ("submitting ideas/social posts").
// ---------------------------------------------------------------------

router.get('/content-review/ideas/new', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const error = req.query.error ? escapeHtml(req.query.error) : null;

    const prefillTitle = req.query.title ? escapeHtml(req.query.title) : '';
    const prefillBrief = req.query.brief ? escapeHtml(req.query.brief) : '';
    const sourceTopicSuggestionId = req.query.source_topic_suggestion_id
      ? escapeHtml(req.query.source_topic_suggestion_id)
      : null;

    const contentTypeOptions = VALID_CONTENT_TYPES.map(
      (t) => `<option value="${t}">${escapeHtml(t.replace(/_/g, ' '))}</option>`
    ).join('\n');

    const topics = await listTopics();
    const topicCheckboxHtml = topics
      .map(
        (t) => `
        <label>
          <input type="checkbox" name="topics" value="${escapeHtml(t.topic_key)}">
          ${escapeHtml(topicLabel(t.topic_key))}
        </label>`
      )
      .join('\n');

    res.send(
    layoutModule.layout({
      title: 'Submit an Idea',
      user: { email: req.session.userEmail },
      flash: null,
      body: `
        <h2>Submit an Idea</h2>
        <p style="color:#666;font-size:0.9rem;">
          Fill this in and we'll generate a full draft using the same writing
          process as every other piece — grounded only in Rincon's verified
          legal knowledge base, with any uncertain facts flagged for human
          review. Nothing is published automatically; the draft lands in the
          normal review queue to approve, edit, or reject.
        </p>
        ${error ? `<div class="flash error">${error}</div>` : ''}
        <div class="card">
          <form method="POST" action="/content-review/ideas/new">
            ${sourceTopicSuggestionId ? `<input type="hidden" name="source_topic_suggestion_id" value="${sourceTopicSuggestionId}">` : ''}
            <label for="title">Working title</label>
            <input type="text" id="title" name="title" required data-dictation="true" placeholder="e.g. What Ventura County Landlords Need to Know About Security Deposits" value="${prefillTitle}">

            <label for="brief">What should this cover? (the angle, audience, key points)</label>
            <textarea id="brief" name="brief" required data-dictation="true" style="min-height:120px;" placeholder="e.g. Explain the current security deposit cap and return timeline rules, aimed at first-time landlords.">${prefillBrief}</textarea>

            <label for="content_type">Content type</label>
            <select id="content_type" name="content_type" required>
              <option value="" disabled selected>Choose one&hellip;</option>
              ${contentTypeOptions}
            </select>

            <label>Which legal topics does this touch on? (optional)</label>
            <div class="helper-text">Select any legal topics this touches, if applicable. Leave blank for general content that isn't legal in nature (e.g. maintenance tips, vendor advice, seasonal reminders) — the draft will be written from your title and brief alone, with no legal citations.</div>
            <div class="checkbox-group">
              ${topicCheckboxHtml}
            </div>

            <label for="inspiration_piece">Inspiration piece (optional)</label>
            <div class="helper-text">Paste an example article here and the AI will model this draft's voice, tone, and structure after it. This does NOT get saved or reused for future drafts &mdash; it only affects this one generation, and no facts or claims are pulled from it (legal facts still come only from Rincon's verified knowledge base).</div>
            <textarea id="inspiration_piece" name="inspiration_piece" style="min-height:120px;" placeholder="Paste a reference article here to match its style for this draft only..."></textarea>

            <div class="actions">
              <button type="submit" class="btn-approve">Generate Draft</button>
            </div>
          </form>
        </div>
        <div class="safety-note">
          Submitting this only creates a draft in the review queue — it does
          not publish or send anything anywhere.
        </div>
        <script src="/content-review/static/dictation.js"></script>
      `,
    })
  );
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/ideas/new', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const { title, brief, content_type, inspiration_piece, source_topic_suggestion_id } = req.body;
    const topics = req.body.topics
      ? (Array.isArray(req.body.topics) ? req.body.topics : [req.body.topics])
      : [];
    const inspirationPiece =
      inspiration_piece && inspiration_piece.trim() ? inspiration_piece.trim() : null;
    const sourceTopicSuggestionId =
      typeof source_topic_suggestion_id === 'string' && source_topic_suggestion_id.trim()
        ? source_topic_suggestion_id.trim()
        : null;

    if (!title || !title.trim()) {
      return res.redirect('/content-review/ideas/new?error=' + encodeURIComponent('A working title is required.'));
    }
    if (!brief || !brief.trim()) {
      return res.redirect('/content-review/ideas/new?error=' + encodeURIComponent('Please describe what the piece should cover.'));
    }
    if (!VALID_CONTENT_TYPES.includes(content_type)) {
      return res.redirect('/content-review/ideas/new?error=' + encodeURIComponent('Please choose a content type.'));
    }

    res.send(
      layoutModule.layout({
        title: 'Generating your draft...',
        user: { email: req.session.userEmail },
        flash: null,
        body: `
          <div class="generating-wrap">
            <div class="spinner"></div>
            <h2>Generating your draft&hellip;</h2>
            <p style="color:#666;">This usually takes 20-30 seconds. Please don't close this tab.</p>
            <div id="gen-error" class="flash error" style="display:none;"></div>
          </div>
          <form id="retry-form" method="GET" action="/content-review/ideas/new" style="display:none;"></form>
          <script src="/content-review/static/generation-fetch.js"></script>
          <script>
            (function () {
              var payload = ${JSON.stringify({
                title: title.trim(),
                brief: brief.trim(),
                content_type,
                topics,
                inspiration_piece: inspirationPiece,
                source_topic_suggestion_id: sourceTopicSuggestionId,
              }).replace(/<\//g, '<\\/')};
              generationFetchWithTimeout('/content-review/ideas/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              })
                .then(function (result) {
                  if (result.ok && result.data.redirect) {
                    window.location.href = result.data.redirect;
                  } else {
                    throw new Error((result.data && result.data.error) || 'Something went wrong generating the draft.');
                  }
                })
                .catch(function (err) {
                  document.querySelector('.spinner').style.display = 'none';
                  var errBox = document.getElementById('gen-error');
                  var suffix = err.isTimeout ? '' : ' — go back and try again.';
                  errBox.textContent = err.message + suffix;
                  errBox.style.display = 'block';
                });
            })();
          </script>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/ideas/generate', requireContentEngineAccess, async (req, res) => {
  try {
    const { title, brief, content_type, topics, inspiration_piece, source_topic_suggestion_id } = req.body;

    if (!title || !brief || !VALID_CONTENT_TYPES.includes(content_type) || !Array.isArray(topics)) {
      return res.status(400).json({ error: 'Missing or invalid idea details.' });
    }

    const inspirationPiece =
      typeof inspiration_piece === 'string' && inspiration_piece.trim()
        ? inspiration_piece.trim()
        : null;

    const sourceTopicSuggestionId =
      typeof source_topic_suggestion_id === 'string' && source_topic_suggestion_id.trim()
        ? source_topic_suggestion_id.trim()
        : null;

    const { contentItem } = await timeGeneration(
      `draftContent title="${title}" contentType=${content_type}`,
      () => draftContent({
        title,
        brief,
        contentType: content_type,
        topicKeywords: topics,
        authorName: req.session.userEmail || null,
        inspirationPiece,
        sourceTopicSuggestionId,
      })
    );

    res.json({ redirect: `/content-review/items/${contentItem.id}?flash=${encodeURIComponent('Draft generated — review it below.')}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Draft generation failed. This is usually a temporary issue — please try again.' });
  }
});

// ---------------------------------------------------------------------
// BRAND VOICE GUIDE — self-serve upload/version history. Viewing is open
// to contributor or admin; saving a new version is admin-only ("brand-
// voice-guide edits").
// ---------------------------------------------------------------------

router.get('/content-review/brand-guide', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const rows = await select(
      'brand_guides',
      'select=*&content=not.is.null&order=created_at.desc'
    );
    const current = rows[0] || null;
    const history = rows.slice(1);
    const isAdmin = req.contentEngineRole === 'admin';

    const currentBlock = current
      ? `
        <div class="card">
          <h3>Current brand voice guide</h3>
          <p class="item-meta">Active since ${new Date(current.created_at).toLocaleString()}</p>
          <div class="draft-body">${escapeHtml(current.content)}</div>
        </div>`
      : `
        <div class="card">
          <h3>Current brand voice guide</h3>
          <div class="empty-state">No brand voice guide has been added yet.${isAdmin ? ' Use the form below to add one — it will automatically be used to guide the voice and style of every draft generated from now on.' : ''}</div>
        </div>`;

    const editCardHtml = isAdmin
      ? `
      <div class="card">
        <h3>${current ? 'Edit and save a new version' : 'Add your brand voice guide'}</h3>
        <p style="font-size:0.85rem;color:#666;">
          ${
            current
              ? "This textarea is pre-filled with the current guide — edit it and save to create a new version. Saving does not overwrite the current guide; it adds a new version and keeps the old one in the history below, so you can always see what changed."
              : 'Describe how Rincon\'s content should sound — tone, vocabulary, sentence style, structure preferences. This guides voice and style only; it will never be used as a source of facts.'
          }
        </p>
        <form method="POST" action="/content-review/brand-guide" class="inline-form">
          <label for="content">Brand voice guide content</label>
          <textarea id="content" name="content" required style="min-height:260px;" placeholder="Describe Rincon's voice: tone, vocabulary to use or avoid, sentence style, formatting preferences, examples of good phrasing, etc.">${current ? escapeHtml(current.content) : ''}</textarea>
          <label for="notes">Notes about this version (optional)</label>
          <input type="text" id="notes" name="notes" placeholder="e.g. Added guidance on avoiding jargon">
          <div class="actions">
            <button type="submit" class="btn-approve">Save as new version</button>
          </div>
        </form>
      </div>
      `
      : `
      <div class="card">
        <h3>Editing</h3>
        <p class="item-meta">Saving a new version requires admin access to Content Review.</p>
      </div>
      `;

    const historyBlock = history.length
      ? `
        <div class="card">
          <h3>Version history</h3>
          ${history
            .map(
              (h) => `
            <details class="claim">
              <summary>Version from ${new Date(h.created_at).toLocaleString()}${h.notes ? ' — ' + escapeHtml(h.notes) : ''}</summary>
              <div class="claim-body" style="white-space:pre-wrap;">${escapeHtml(h.content)}</div>
            </details>`
            )
            .join('\n')}
        </div>`
      : '';

    res.send(
      layoutModule.layout({
        title: 'Brand Voice Guide',
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <h2>Brand Voice Guide</h2>
          <p style="color:#666;font-size:0.9rem;">
            This guide shapes the VOICE AND STYLE of every draft the content
            engine generates from now on (new drafts and AI revisions alike)
            — things like tone, vocabulary, sentence rhythm, and structure
            preferences. It is never used as a source of legal facts;
            grounding claims from Rincon's verified legal knowledge base are
            always the only source of facts, exactly as before.
          </p>

          ${currentBlock}

          ${editCardHtml}

          ${historyBlock}

          <div class="safety-note">
            This page only reads and writes rows in the brand_guides table.
            Nothing here posts, publishes, or sends anything anywhere. The
            guide's content is style guidance only — it is never presented
            as a legal fact in any draft.
          </div>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post(
  '/content-review/brand-guide',
  requireContentEngineAdminOrRedirect('/content-review/brand-guide'),
  async (req, res, next) => {
    try {
      const { content, notes } = req.body;
      if (!content || !content.trim()) {
        return res.redirect(`/content-review/brand-guide?flash=${encodeURIComponent('Brand guide content is required.')}&flashType=error`);
      }
      await insert('brand_guides', {
        guide_name: 'default',
        content: content.trim(),
        notes: notes && notes.trim() ? notes.trim() : null,
      });
      res.redirect(`/content-review/brand-guide?flash=${encodeURIComponent('Brand voice guide saved as a new version.')}`);
    } catch (err) {
      next(err);
    }
  }
);

// ---------------------------------------------------------------------
// TOPIC SUGGESTIONS queue — open to contributor or admin. This is triage
// ("worth drafting?"), not a final content decision — see the file header
// for why this is treated differently from the content_items
// approve/reject above.
// ---------------------------------------------------------------------

const FEED_SOURCE_LABELS = {
  legislative_trend_forum_scan: 'legislative trend scan',
  viral_trend_scan: 'viral trend scan',
  civic_council_monitoring: 'civic council monitoring',
};

router.get('/content-review/topics', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const archivedFilter = req.query.status === 'archived';
    const topics = await select(
      'topic_suggestions',
      archivedFilter ? 'select=*&archived=eq.true&order=created_at.desc' : 'select=*&archived=eq.false&order=created_at.desc'
    );
    const pending = topics.filter((t) => t.status === 'pending');
    const decided = topics.filter((t) => t.status !== 'pending');

    const scanRuns = await select('topic_scan_runs', 'select=*&order=ran_at.desc');
    const latestRunByFeed = {};
    for (const run of scanRuns) {
      if (!latestRunByFeed[run.feed_source]) {
        latestRunByFeed[run.feed_source] = run;
      }
    }
    const scanStatusHtml = Object.values(latestRunByFeed)
      .map((run) => {
        const feedLabel = escapeHtml(FEED_SOURCE_LABELS[run.feed_source] || run.feed_source.replace(/_/g, ' '));
        const when = new Date(run.ran_at).toLocaleString();
        if (run.succeeded) {
          const count = run.suggestions_created || 0;
          return `<p class="item-meta">Last scan (${feedLabel}): ${when} — succeeded, ${count} new suggestion${count === 1 ? '' : 's'}</p>`;
        }
        return `<div class="flash error">Last scan (${feedLabel}): ${when} — FAILED${run.error_message ? ' — ' + escapeHtml(run.error_message) : ''}</div>`;
      })
      .join('\n');

    const renderTopic = (t) => `
      <div class="card">
        <div class="item-title">${escapeHtml(t.topic_summary)}</div>
        <div>
          <span class="badge status-${t.status}">${t.status}</span>
          <span class="badge status-draft">${escapeHtml(t.feed_source.replace(/_/g, ' '))}</span>
          ${t.archived ? '<span class="badge sensitive">archived</span>' : ''}
        </div>
        <p style="font-size:0.9rem;color:#555;">${escapeHtml(t.relevance_note)}</p>
        ${
          t.youtube_video_id
            ? `<p><a href="https://www.youtube.com/watch?v=${escapeHtml(t.youtube_video_id)}" target="_blank" rel="noopener">Watch the video</a></p>`
            : ''
        }
        ${
          t.status === 'pending'
            ? `<div class="actions">
                <form method="POST" action="/content-review/topics/${t.id}/approve" style="display:inline;">
                  <button type="submit" class="btn-approve">Approve</button>
                </form>
                <form method="POST" action="/content-review/topics/${t.id}/reject" style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:200px;">
                  <input type="text" name="rejection_note" placeholder="Why? (optional)">
                  <button type="submit" class="btn-reject">Reject</button>
                </form>
              </div>`
            : `
              ${t.rejection_note ? `<p class="item-meta">Rejection note: ${escapeHtml(t.rejection_note)}</p>` : ''}
              <div class="actions">
                ${
                  t.archived
                    ? `<form method="POST" action="/content-review/topics/${t.id}/unarchive" style="display:inline;">
                        <button type="submit" class="btn-secondary">Unarchive</button>
                      </form>`
                    : `<form method="POST" action="/content-review/topics/${t.id}/archive" style="display:inline;">
                        <button type="submit" class="btn-secondary">Archive</button>
                      </form>`
                }
              </div>`
        }
      </div>`;

    const filterLinks = [
      `<a href="/content-review/topics"${!archivedFilter ? ' class="active"' : ''}>All</a>`,
      `<a href="/content-review/topics?status=archived"${archivedFilter ? ' class="active"' : ''}>Archived</a>`,
    ].join('\n');

    res.send(
      layoutModule.layout({
        title: 'Topic Suggestions',
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <h2>Topic Suggestions</h2>
          <p style="color:#666;font-size:0.9rem;">
            Candidate topics surfaced from discovery feeds (legislative/trend
            scans, viral trend scans, civic council monitoring) — see
            <a href="/content-engine">Content Engine</a> to run a scan.
          </p>
          <div class="filters">${filterLinks}</div>
          ${scanStatusHtml}
          ${
            archivedFilter
              ? topics.length === 0
                ? '<div class="empty-state">No archived topic suggestions.</div>'
                : topics.map(renderTopic).join('\n')
              : `
                ${pending.length === 0 ? '<div class="empty-state">No pending topic suggestions.</div>' : pending.map(renderTopic).join('\n')}
                ${decided.length > 0 ? '<h3>Already decided</h3>' + decided.map(renderTopic).join('\n') : ''}
              `
          }
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/topics/:id/approve', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const topic = await selectOne('topic_suggestions', req.params.id);
    if (!topic) return res.status(404).send('Topic not found.');
    const updated = await updateOne('topic_suggestions', req.params.id, { status: 'approved' });
    if (!updated) return res.status(404).send('Topic not found.');
    const params = new URLSearchParams({
      title: topic.topic_summary || '',
      brief: topic.relevance_note || '',
      source_topic_suggestion_id: topic.id,
    });
    res.redirect(`/content-review/ideas/new?${params.toString()}`);
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/topics/:id/reject', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const rejectionNote =
      typeof req.body.rejection_note === 'string' && req.body.rejection_note.trim()
        ? req.body.rejection_note.trim()
        : null;
    const updated = await updateOne('topic_suggestions', req.params.id, {
      status: 'rejected',
      rejection_note: rejectionNote,
    });
    if (!updated) return res.status(404).send('Topic not found.');
    res.redirect(`/content-review/topics?flash=${encodeURIComponent('Topic rejected.')}&flashType=error`);
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/topics/:id/archive', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const updated = await updateOne('topic_suggestions', req.params.id, { archived: true });
    if (!updated) return res.status(404).send('Topic not found.');
    res.redirect(`/content-review/topics?flash=${encodeURIComponent('Topic archived.')}`);
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/topics/:id/unarchive', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const updated = await updateOne('topic_suggestions', req.params.id, { archived: false });
    if (!updated) return res.status(404).send('Topic not found.');
    res.redirect(`/content-review/topics?flash=${encodeURIComponent('Topic unarchived.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// LEGAL UPDATES — review queue for legal_update_candidates. A TRIAGE queue
// only (see the migration's own two-step rule) — open to contributor or
// admin, same reasoning as Topic Suggestions above.
// ---------------------------------------------------------------------

const LEGAL_UPDATE_STATUSES = ['pending', 'approved', 'rejected'];

router.get('/content-review/legal-updates', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const statusFilter = LEGAL_UPDATE_STATUSES.includes(req.query.status) ? req.query.status : 'pending';

    const candidates = await select(
      'legal_update_candidates',
      `select=*,compliance_topics(topic_key)&review_status=eq.${statusFilter}&order=discovered_at.desc`
    );

    const renderCandidate = (c) => {
      const topicKey = c.compliance_topics && c.compliance_topics.topic_key;
      const topicHtml = topicKey
        ? `<span class="badge status-draft">${escapeHtml(topicLabel(topicKey))}</span>`
        : '';

      let claimStatusHtml = '';
      if (c.resulting_claim_id) {
        claimStatusHtml = '<span class="badge status-approved">&#10003; Legal claim written</span>';
      } else if (c.review_status === 'approved') {
        claimStatusHtml = '<span class="badge sensitive">Approved &mdash; legal claim not yet written</span>';
      }

      return `
      <div class="card">
        <div class="item-title">${escapeHtml(c.bill_number)}</div>
        <div>
          <span class="badge status-${c.review_status}">${c.review_status}</span>
          ${topicHtml}
          ${claimStatusHtml}
        </div>
        <p style="font-size:0.9rem;color:#555;">${escapeHtml(c.summary)}</p>
        <p><a href="${escapeHtml(c.source_url)}" target="_blank" rel="noopener">Read the bill</a></p>
        <p class="item-meta">Discovered ${new Date(c.discovered_at).toLocaleDateString()}</p>
        ${
          c.review_status === 'pending'
            ? `<div class="actions">
                <form method="POST" action="/content-review/legal-updates/${c.id}/approve" style="display:inline;">
                  <button type="submit" class="btn-approve">Approve</button>
                </form>
                <form method="POST" action="/content-review/legal-updates/${c.id}/reject" style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:200px;">
                  <input type="text" name="rejection_note" placeholder="Why? (optional)">
                  <button type="submit" class="btn-reject">Reject</button>
                </form>
              </div>`
            : ''
        }
        ${c.rejection_note ? `<p class="item-meta">Rejection note: ${escapeHtml(c.rejection_note)}</p>` : ''}
      </div>`;
    };

    const filterLinks = [
      `<a href="/content-review/legal-updates"${statusFilter === 'pending' ? ' class="active"' : ''}>Pending</a>`,
      `<a href="/content-review/legal-updates?status=approved"${statusFilter === 'approved' ? ' class="active"' : ''}>Approved</a>`,
      `<a href="/content-review/legal-updates?status=rejected"${statusFilter === 'rejected' ? ' class="active"' : ''}>Rejected</a>`,
    ].join('\n');

    res.send(
      layoutModule.layout({
        title: 'Legal Updates',
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <h2>Legal Updates (California Bills)</h2>
          <p style="color:#666;font-size:0.9rem;">
            These are California bills that have been signed into law, found
            automatically — see <a href="/content-engine">Content Engine</a>
            to run a scan. Approving one here just means &ldquo;worth Mason
            writing up as a real legal reference&rdquo; &mdash; it does NOT
            create a citable legal fact by itself. A real, verified entry
            still has to be written separately before the AI can ever use it.
          </p>
          <div class="filters">${filterLinks}</div>
          ${
            candidates.length === 0
              ? `<div class="empty-state">No ${escapeHtml(statusFilter)} candidates.</div>`
              : candidates.map(renderCandidate).join('\n')
          }
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/legal-updates/:id/approve', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const updated = await updateOne('legal_update_candidates', req.params.id, {
      review_status: 'approved',
      reviewed_by: req.session.userEmail,
      reviewed_at: new Date().toISOString(),
    });
    if (!updated) return res.status(404).send('Candidate not found.');
    res.redirect(
      `/content-review/legal-updates?flash=${encodeURIComponent("Marked as worth writing up — still needs a real legal claim entry before it's usable.")}`
    );
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/legal-updates/:id/reject', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const rejectionNote =
      typeof req.body.rejection_note === 'string' && req.body.rejection_note.trim()
        ? req.body.rejection_note.trim()
        : null;
    const updated = await updateOne('legal_update_candidates', req.params.id, {
      review_status: 'rejected',
      reviewed_by: req.session.userEmail,
      reviewed_at: new Date().toISOString(),
      rejection_note: rejectionNote,
    });
    if (!updated) return res.status(404).send('Candidate not found.');
    res.redirect(`/content-review/legal-updates?flash=${encodeURIComponent('Candidate rejected.')}&flashType=error`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// SOCIAL CAPTIONS review, per approved blog post — open to contributor or
// admin.
// ---------------------------------------------------------------------

router.get('/content-review/items/:id/captions', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');

    const captions = await select('social_captions', `select=*&content_item_id=eq.${item.id}&order=platform.asc`);

    const captionsHtml = captions.length
      ? captions
          .map(
            (c) => `
        <div class="caption-block">
          <div class="caption-platform">${escapeHtml(c.platform)} <span class="badge status-${c.status}">${c.status}</span></div>
          <p style="white-space:pre-wrap;">${escapeHtml(c.caption_text)}</p>
          ${
            c.status === 'pending'
              ? `<div class="actions">
                  <form method="POST" action="/content-review/captions/${c.id}/approve" style="display:inline;">
                    <button type="submit" class="btn-approve">Approve</button>
                  </form>
                  <form method="POST" action="/content-review/captions/${c.id}/reject" style="display:inline;">
                    <button type="submit" class="btn-reject">Reject</button>
                  </form>
                </div>`
              : ''
          }
        </div>`
          )
          .join('\n')
      : '<div class="empty-state">No captions generated yet for this post.</div>';

    res.send(
      layoutModule.layout({
        title: `Captions — ${item.title}`,
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <p><a href="/content-review/items/${item.id}">&larr; Back to draft</a></p>
          <h2>Social captions for: ${escapeHtml(item.title)}</h2>
          ${captionsHtml}
          <div class="safety-note">
            Approving a caption here only marks it approved in the database.
            Nobody posts it automatically — copying it to Facebook, LinkedIn,
            or Instagram is a manual step someone does outside this app.
          </div>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

function captionReturnUrl(caption) {
  return caption.content_item_id
    ? `/content-review/items/${caption.content_item_id}/captions`
    : `/content-review/social/batches/${caption.batch_id}`;
}

router.post('/content-review/captions/:id/approve', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const caption = await updateOne('social_captions', req.params.id, { status: 'approved' });
    if (!caption) return res.status(404).send('Caption not found.');
    res.redirect(`${captionReturnUrl(caption)}?flash=${encodeURIComponent('Caption approved.')}`);
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/captions/:id/reject', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const caption = await updateOne('social_captions', req.params.id, { status: 'rejected' });
    if (!caption) return res.status(404).send('Caption not found.');
    res.redirect(`${captionReturnUrl(caption)}?flash=${encodeURIComponent('Caption rejected.')}&flashType=error`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// GENERATE SOCIAL CAPTIONS — self-serve button on an approved blog post's
// detail page. Open to contributor or admin ("triggering captions").
// ---------------------------------------------------------------------

router.get('/content-review/items/:id/captions/generate', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');
    if (item.content_type !== 'blog_post' || item.status !== 'approved') {
      return res.redirect(
        `/content-review/items/${item.id}?flash=${encodeURIComponent('Social captions can only be generated for approved blog posts.')}&flashType=error`
      );
    }

    res.send(
      layoutModule.layout({
        title: 'Generating Social Captions...',
        user: { email: req.session.userEmail },
        flash: null,
        body: `
          <div class="generating-wrap">
            <div class="spinner"></div>
            <h2>Generating social captions&hellip;</h2>
            <p style="color:#666;">Writing Facebook, LinkedIn, and Instagram captions for this post. This usually takes 10-20 seconds. Please don't close this tab.</p>
            <div id="gen-error" class="flash error" style="display:none;"></div>
          </div>
          <form id="retry-form" method="GET" action="/content-review/items/${item.id}" style="display:none;"></form>
          <script src="/content-review/static/generation-fetch.js"></script>
          <script>
            (function () {
              generationFetchWithTimeout('/content-review/items/${item.id}/captions/generate', { method: 'POST' })
                .then(function (result) {
                  if (result.ok && result.data.redirect) {
                    window.location.href = result.data.redirect;
                  } else {
                    throw new Error((result.data && result.data.error) || 'Something went wrong generating captions.');
                  }
                })
                .catch(function (err) {
                  document.querySelector('.spinner').style.display = 'none';
                  var errBox = document.getElementById('gen-error');
                  var suffix = err.isTimeout ? '' : ' — go back and try again.';
                  errBox.textContent = err.message + suffix;
                  errBox.style.display = 'block';
                });
            })();
          </script>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/items/:id/captions/generate', requireContentEngineAccess, async (req, res) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).json({ error: 'Draft not found.' });
    if (item.content_type !== 'blog_post' || item.status !== 'approved') {
      return res.status(400).json({ error: 'Social captions can only be generated for approved blog posts.' });
    }

    await timeGeneration(`generateCaptions item=${item.id}`, () => generateCaptions(item.id));

    res.json({
      redirect: `/content-review/items/${item.id}/captions?flash=${encodeURIComponent('3 new captions generated — review them below.')}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Caption generation failed. This is usually a temporary issue — please try again.' });
  }
});

// ---------------------------------------------------------------------
// STANDALONE SOCIAL POSTS — social captions with no parent blog post.
// Open to contributor or admin ("submitting ideas/social posts").
// ---------------------------------------------------------------------

router.get('/content-review/social/new', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const error = req.query.error ? escapeHtml(req.query.error) : null;

    const topics = await listTopics();
    const topicCheckboxHtml = topics
      .map(
        (t) => `
        <label>
          <input type="checkbox" name="topics" value="${escapeHtml(t.topic_key)}">
          ${escapeHtml(topicLabel(t.topic_key))}
        </label>`
      )
      .join('\n');

    res.send(
      layoutModule.layout({
        title: 'New Social Post',
        user: { email: req.session.userEmail },
        flash: null,
        body: `
          <h2>New Social Post</h2>
          <p style="color:#666;font-size:0.9rem;">
            Use this when you want social captions without writing a full blog
            post first. This generates 3 captions (Facebook, LinkedIn,
            Instagram) grounded only in Rincon's verified legal knowledge
            base, with any uncertain facts flagged for human review. Nothing
            is posted automatically — the captions land in the standalone
            captions queue to approve, edit, or reject.
          </p>
          ${error ? `<div class="flash error">${error}</div>` : ''}
          <div class="card">
            <form method="POST" action="/content-review/social/new">
              <label for="title">Topic / working title</label>
              <input type="text" id="title" name="title" required data-dictation="true" placeholder="e.g. Spring Move-Out Checklist for Tenants">

              <label for="brief">What should these captions cover? (the angle, audience, key points)</label>
              <textarea id="brief" name="brief" required data-dictation="true" style="min-height:120px;" placeholder="e.g. Remind tenants what's expected before move-out inspections, aimed at current renters."></textarea>

              <label>Which legal topics does this touch on? (optional)</label>
              <div class="helper-text">Select any legal topics this touches, if applicable. Leave blank for general content that isn't legal in nature (e.g. maintenance tips, seasonal reminders) — captions will be written from your title and brief alone, with no legal citations.</div>
              <div class="checkbox-group">
                ${topicCheckboxHtml}
              </div>

              <label for="inspiration_piece">Inspiration piece (optional)</label>
              <div class="helper-text">Paste an example post here and the AI will model these captions' voice and tone after it. This does NOT get saved or reused for future posts &mdash; it only affects this one generation, and no facts or claims are pulled from it (legal facts still come only from Rincon's verified knowledge base).</div>
              <textarea id="inspiration_piece" name="inspiration_piece" style="min-height:120px;" placeholder="Paste a reference post here to match its style for this generation only..."></textarea>

              <div class="actions">
                <button type="submit" class="btn-approve">Generate Captions</button>
              </div>
            </form>
          </div>
          <div class="safety-note">
            Submitting this only creates pending captions in the review
            queue — it does not publish or send anything anywhere.
          </div>
          <script src="/content-review/static/dictation.js"></script>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/social/new', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const { title, brief, inspiration_piece } = req.body;
    const topics = req.body.topics
      ? (Array.isArray(req.body.topics) ? req.body.topics : [req.body.topics])
      : [];
    const inspirationPiece =
      inspiration_piece && inspiration_piece.trim() ? inspiration_piece.trim() : null;

    if (!title || !title.trim()) {
      return res.redirect('/content-review/social/new?error=' + encodeURIComponent('A topic / working title is required.'));
    }
    if (!brief || !brief.trim()) {
      return res.redirect('/content-review/social/new?error=' + encodeURIComponent('Please describe what these captions should cover.'));
    }

    res.send(
      layoutModule.layout({
        title: 'Generating your captions...',
        user: { email: req.session.userEmail },
        flash: null,
        body: `
          <div class="generating-wrap">
            <div class="spinner"></div>
            <h2>Generating your captions&hellip;</h2>
            <p style="color:#666;">This usually takes 10-20 seconds. Please don't close this tab.</p>
            <div id="gen-error" class="flash error" style="display:none;"></div>
          </div>
          <form id="retry-form" method="GET" action="/content-review/social/new" style="display:none;"></form>
          <script src="/content-review/static/generation-fetch.js"></script>
          <script>
            (function () {
              var payload = ${JSON.stringify({
                title: title.trim(),
                brief: brief.trim(),
                topics,
                inspiration_piece: inspirationPiece,
              }).replace(/<\//g, '<\\/')};
              generationFetchWithTimeout('/content-review/social/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
              })
                .then(function (result) {
                  if (result.ok && result.data.redirect) {
                    window.location.href = result.data.redirect;
                  } else {
                    throw new Error((result.data && result.data.error) || 'Something went wrong generating the captions.');
                  }
                })
                .catch(function (err) {
                  document.querySelector('.spinner').style.display = 'none';
                  var errBox = document.getElementById('gen-error');
                  var suffix = err.isTimeout ? '' : ' — go back and try again.';
                  errBox.textContent = err.message + suffix;
                  errBox.style.display = 'block';
                });
            })();
          </script>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/social/generate', requireContentEngineAccess, async (req, res) => {
  try {
    const { title, brief, topics, inspiration_piece } = req.body;

    if (!title || !brief || !Array.isArray(topics)) {
      return res.status(400).json({ error: 'Missing or invalid post details.' });
    }

    const inspirationPiece =
      typeof inspiration_piece === 'string' && inspiration_piece.trim()
        ? inspiration_piece.trim()
        : null;

    const { batchId } = await timeGeneration(
      `generateStandaloneCaptions title="${title}"`,
      () => generateStandaloneCaptions({
        title,
        brief,
        topicKeywords: topics,
        inspirationPiece,
      })
    );

    res.json({
      redirect: `/content-review/social/batches/${batchId}?flash=${encodeURIComponent('3 captions generated — review them below.')}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Caption generation failed. This is usually a temporary issue — please try again.' });
  }
});

router.get('/content-review/social/batches', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const archivedFilter = req.query.status === 'archived';
    const captions = await select(
      'social_captions',
      `select=*&content_item_id=is.null&archived=eq.${archivedFilter}&order=created_at.desc`
    );

    const batches = {};
    for (const c of captions) {
      if (!c.batch_id) continue; // safety: skip any legacy row with no batch grouping
      if (!batches[c.batch_id]) {
        batches[c.batch_id] = { batch_id: c.batch_id, topic_label: c.topic_label, created_at: c.created_at, captions: [] };
      }
      batches[c.batch_id].captions.push(c);
      if (c.created_at < batches[c.batch_id].created_at) batches[c.batch_id].created_at = c.created_at;
    }

    const batchList = Object.values(batches).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const rows = batchList
      .map((b) => {
        const pendingCount = b.captions.filter((c) => c.status === 'pending').length;
        const isArchived = b.captions.every((c) => c.archived);
        return `
        <div class="card">
          <div class="item-title"><a href="/content-review/social/batches/${b.batch_id}">${escapeHtml(b.topic_label || 'Untitled social post')}</a></div>
          <div>
            ${pendingCount > 0 ? `<span class="badge status-pending">${pendingCount} pending</span>` : '<span class="badge status-approved">all reviewed</span>'}
            <span class="badge status-draft">${b.captions.length} caption${b.captions.length === 1 ? '' : 's'}</span>
            ${isArchived ? '<span class="badge sensitive">archived</span>' : ''}
          </div>
          <div class="item-meta">Created ${new Date(b.created_at).toLocaleDateString()}</div>
        </div>`;
      })
      .join('\n');

    const filterLinks = [
      `<a href="/content-review/social/batches"${!archivedFilter ? ' class="active"' : ''}>All</a>`,
      `<a href="/content-review/social/batches?status=archived"${archivedFilter ? ' class="active"' : ''}>Archived</a>`,
    ].join('\n');

    res.send(
      layoutModule.layout({
        title: 'Standalone Social Batches',
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <h2>Standalone Social Posts</h2>
          <p style="color:#666;font-size:0.9rem;">
            Social captions generated without a parent blog post (see
            <a href="/content-review/social/new">New Social Post</a>), grouped by submission.
          </p>
          <div class="filters">${filterLinks}</div>
          ${
            batchList.length === 0
              ? `<div class="empty-state">No ${archivedFilter ? 'archived' : ''} standalone social posts${archivedFilter ? '' : ' yet'}.</div>`
              : rows
          }
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.get('/content-review/social/batches/:batchId', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const captions = await select(
      'social_captions',
      `select=*&batch_id=eq.${req.params.batchId}&order=platform.asc`
    );
    if (captions.length === 0) return res.status(404).send('Social post batch not found.');

    const topicLabelText = captions[0].topic_label || 'Untitled social post';
    const isArchived = captions.every((c) => c.archived);

    const captionsHtml = captions
      .map(
        (c) => `
      <div class="caption-block">
        <div class="caption-platform">${escapeHtml(c.platform)} <span class="badge status-${c.status}">${c.status}</span></div>
        <p style="white-space:pre-wrap;">${escapeHtml(c.caption_text)}</p>
        ${
          c.status === 'pending'
            ? `<div class="actions">
                <form method="POST" action="/content-review/captions/${c.id}/approve" style="display:inline;">
                  <button type="submit" class="btn-approve">Approve</button>
                </form>
                <form method="POST" action="/content-review/captions/${c.id}/reject" style="display:inline;">
                  <button type="submit" class="btn-reject">Reject</button>
                </form>
              </div>`
            : ''
        }
      </div>`
      )
      .join('\n');

    res.send(
      layoutModule.layout({
        title: `Social captions — ${topicLabelText}`,
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <p><a href="/content-review/social/batches">&larr; Back to standalone social posts</a></p>
          <h2>Social captions for: ${escapeHtml(topicLabelText)}</h2>
          <div>
            ${isArchived ? '<span class="badge sensitive">archived</span>' : ''}
          </div>
          ${captionsHtml}
          <div class="safety-note">
            Approving a caption here only marks it approved in the database.
            Nobody posts it automatically — copying it to Facebook, LinkedIn,
            or Instagram is a manual step someone does outside this app.
          </div>

          <div class="card">
            <h3>Archive</h3>
            <p style="font-size:0.85rem;color:#666;">
              ${
                isArchived
                  ? 'This batch is archived and hidden from the main list. Unarchiving brings it back to the normal view — this does not change any caption\'s approval status.'
                  : 'Archiving hides this whole batch from the main list without changing any caption\'s approval status. You can find it later under the "Archived" filter and bring it back any time.'
              }
            </p>
            <div class="actions">
              ${
                isArchived
                  ? `<form method="POST" action="/content-review/social/batches/${req.params.batchId}/unarchive" style="display:inline;">
                      <button type="submit" class="btn-secondary">Unarchive</button>
                    </form>`
                  : `<form method="POST" action="/content-review/social/batches/${req.params.batchId}/archive" style="display:inline;">
                      <button type="submit" class="btn-secondary">Archive</button>
                    </form>`
              }
            </div>
          </div>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/social/batches/:batchId/archive', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const updated = await update('social_captions', `batch_id=eq.${req.params.batchId}`, { archived: true });
    if (updated.length === 0) return res.status(404).send('Social post batch not found.');
    res.redirect(`/content-review/social/batches/${req.params.batchId}?flash=${encodeURIComponent('Batch archived — hidden from the main list.')}`);
  } catch (err) {
    next(err);
  }
});

router.post('/content-review/social/batches/:batchId/unarchive', requireContentEngineAccessPage, async (req, res, next) => {
  try {
    const updated = await update('social_captions', `batch_id=eq.${req.params.batchId}`, { archived: false });
    if (updated.length === 0) return res.status(404).send('Social post batch not found.');
    res.redirect(`/content-review/social/batches/${req.params.batchId}?flash=${encodeURIComponent('Batch unarchived — back in the main list.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Error handling — scoped to this router's own routes. The Hub's own
// global error handler (server.js) still runs for anything that escapes
// this one, but this gives a nicer, on-brand "something went wrong, here's
// how to get back" page for the common in-app case, matching what the
// standalone app already showed.
// ---------------------------------------------------------------------

router.use((err, req, res, next) => {
  console.error(`[content-review] ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return next(err);
  res.status(500).send(`
    <html><body style="font-family:sans-serif;padding:40px;">
      <h2>Something went wrong</h2>
      <p>Sorry, something went wrong on our end. Please try again, and let an admin know if it keeps happening.</p>
      <p><a href="/content-review">Back to the draft queue</a></p>
    </body></html>
  `);
});

module.exports = { router };
