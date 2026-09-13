#!/usr/bin/env node
/**
 * server.js
 * Rincon Content Review — a small local web app for Peter (and his team) to
 * review drafts produced by the content engine (projects/content-engine).
 *
 * WHAT THIS APP DOES:
 *   - Shows a queue of content_items (drafts) with status/sensitivity badges
 *   - Shows a detail page per draft: full text, compliance claims cited,
 *     and three actions — Approve / Request Changes / Reject
 *   - For politically_sensitive drafts, allows inline section-level edits
 *   - Shows a topic_suggestions queue (approve/reject candidate topics)
 *   - Shows a social_captions review view per approved blog post
 *   - Logs whole-document edits to content_edits, section edits to
 *     content_section_edits
 *
 * WHAT THIS APP NEVER DOES (Asimov governance sign-off):
 *   - It never calls any external publishing, social media, email, or SMS
 *     API. Every action in this file only reads from or writes a status/
 *     text field to Supabase. Search this file (and lib/db.js) for "fetch("
 *     — the only fetch calls are to SUPABASE_URL, nothing else.
 *   - There is no "publish," "post to Facebook," or "send" button anywhere.
 *     Getting content out into the world happens outside this app, manually,
 *     by Peter.
 *
 * LOGIN: real Supabase Auth (email + password), not an unlisted URL. Every
 * route except /login and /logout is behind requireLogin (lib/middleware.js),
 * which verifies the session cookie against Supabase Auth on every request.
 */

// Look for .env next to this file first (matches how it's deployed on the
// server, e.g. /var/www/content-review/.env), and fall back to the shared
// project-root .env two levels up (matches local dev's nested repo layout,
// e.g. projects/content-review/server.js -> ../../.env). Whichever exists
// first wins — this makes the same file work correctly in both places.
{
  const path = require('path');
  const fs = require('fs');
  const localEnvPath = path.join(__dirname, '.env');
  const sharedEnvPath = path.join(__dirname, '..', '..', '.env');
  const envPath = fs.existsSync(localEnvPath) ? localEnvPath : sharedEnvPath;
  require('dotenv').config({ path: envPath });

  // Also load content-engine's .env (a sibling project directory in both the
  // local layout — projects/content-engine/.env — and the live server's flat
  // layout — /var/www/content-engine/.env). The "Submit an idea" feature
  // (/ideas/new) calls into content-engine's drafting logic directly, which
  // needs ANTHROPIC_API_KEY. On the live server that key only lives in
  // content-engine's own .env, not content-review's, so without this line
  // draft generation would fail with "Missing ANTHROPIC_API_KEY" in
  // production even though it works locally off the shared root .env.
  // dotenv never overwrites a variable that's already set, so this only
  // fills in gaps — it can't clobber content-review's own config.
  const engineEnvPath = path.join(__dirname, '..', 'content-engine', '.env');
  if (fs.existsSync(engineEnvPath)) {
    require('dotenv').config({ path: engineEnvPath });
  }
}

const express = require('express');
const session = require('express-session');
const path = require('path');

const { select, selectOne, insert, update, updateOne } = require('./lib/db');
const { signInWithPassword, updatePasswordWithToken } = require('./lib/auth');
const { requireLogin } = require('./lib/middleware');
const layoutModule = require('./lib/layout');
const { escapeHtml } = layoutModule;
const { renderDraftBody, countReviewFlags } = require('./lib/highlight');
const { renderBodyDiff } = require('./lib/diff-render');

// content-engine is a sibling project directory (see the .env-loading block
// above for why that matters). We reuse its actual drafting function here
// rather than re-implementing the prompt/grounding logic — this is the same
// code path draft-content.js's CLI uses, just called directly instead of
// spawned as a subprocess. Confirmed this resolves correctly both in local
// dev (projects/content-review -> projects/content-engine) and on the live
// server's flat layout (/var/www/content-review -> /var/www/content-engine).
const { draftContent, VALID_CONTENT_TYPES } = require('../content-engine/lib/draft');
const { listTopics } = require('../content-engine/lib/compliance');
const { reviseContent } = require('../content-engine/lib/revise');
const { handleChatMessage } = require('../content-engine/lib/chat');
const { generateCaptions } = require('../content-engine/lib/captions');
const { generateStandaloneCaptions } = require('../content-engine/lib/standalone-captions');
// Legal-review-checkpoint gate (Approve/Publish routes below) and the new
// /items/:id/legal-review page both need this — reused, not reimplemented,
// per that file's own header comment (it must be the only place that ever
// writes content_items.legal_review_status).
const { recomputeLegalReviewStatus, RESOLVED_PETER_DECISIONS } = require('../content-engine/lib/legal-review');

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
// with this so pm2's logs always have a real timestamped record of how long
// it actually took. Before this, a slow or "hung" generation left nothing
// in the logs at all — this is what makes a future "it hung" report
// diagnosable instead of a dead end. Logs to stdout/stderr, which pm2
// already captures on the live server.
// ---------------------------------------------------------------------
const SLOW_GENERATION_THRESHOLD_MS = 45000; // well above the typical 6-30s, well under nginx's 180s proxy timeout

async function timeGeneration(label, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    if (durationMs > SLOW_GENERATION_THRESHOLD_MS) {
      console.warn(`[generation] SLOW: ${label} took ${durationMs}ms`);
    } else {
      console.log(`[generation] ${label} succeeded in ${durationMs}ms`);
    }
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    console.error(`[generation] ${label} FAILED after ${durationMs}ms: ${err.message}`);
    throw err;
  }
}

const app = express();
const PORT = process.env.CONTENT_REVIEW_PORT || 3300;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'rincon-content-review-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
      sameSite: 'lax',
    },
  })
);

const CONTENT_STATUSES = ['draft', 'ready_for_review', 'needs_changes', 'approved', 'published'];

// ---------------------------------------------------------------------
// LOGIN / LOGOUT — no requireLogin on these two routes
// ---------------------------------------------------------------------

app.get('/login', (req, res) => {
  if (req.session && req.session.accessToken) {
    return res.redirect('/');
  }
  const error = req.query.error ? escapeHtml(req.query.error) : null;
  const notice = req.query.notice ? escapeHtml(req.query.notice) : null;
  res.send(
    layoutModule.layout({
      title: 'Log in',
      user: null,
      flash: null,
      body: `
        <div class="login-wrap">
          <h1>Rincon Content Review</h1>
          ${notice ? `<div class="flash success">${notice}</div>` : ''}
          ${error ? `<div class="flash error">${error}</div>` : ''}
          <form method="POST" action="/login">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" required autofocus>
            <label for="password">Password</label>
            <input type="password" id="password" name="password" required>
            <div class="actions" style="margin-top:16px;">
              <button type="submit" class="btn-approve" style="width:100%;">Log in</button>
            </div>
          </form>
          <p style="font-size:0.85rem;color:#777;margin-top:16px;">
            First time logging in? Use the "Forgot password" link your admin
            sent you to set your password before logging in here.
          </p>
        </div>
      `,
    })
  );
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.redirect('/login?error=' + encodeURIComponent('Enter your email and password.'));
  }
  try {
    const { user, session: supaSession } = await signInWithPassword(email, password);
    req.session.accessToken = supaSession.access_token;
    req.session.refreshToken = supaSession.refresh_token;
    req.session.userEmail = user.email;
    res.redirect('/');
  } catch (err) {
    res.redirect('/login?error=' + encodeURIComponent('That email or password is not right. Please try again.'));
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// ---------------------------------------------------------------------
// RESET PASSWORD — landing page for the link in Supabase's reset email.
// No requireLogin here on purpose: someone hitting this link isn't
// logged in yet (that's the whole point of "forgot password").
//
// This Supabase project uses the default (implicit) reset flow, not PKCE:
// the email link redirects here with the recovery token in the URL
// FRAGMENT (after "#"), e.g. #access_token=...&type=recovery. A URL
// fragment never reaches the server — only the browser can see it — so
// GET /reset-password serves a page with a small inline script that reads
// the fragment and POSTs the token + new password to this same route.
// ---------------------------------------------------------------------

app.get('/reset-password', (req, res) => {
  const error = req.query.error ? escapeHtml(req.query.error) : null;
  res.send(
    layoutModule.layout({
      title: 'Set your password',
      user: null,
      flash: null,
      body: `
        <div class="login-wrap">
          <h1>Set your new password</h1>
          <div id="no-token-msg" class="flash error" style="display:none;">
            This reset link is missing or has expired. Go back to the email
            and click the link again, or ask your admin to send a new one.
          </div>
          ${error ? `<div class="flash error">${error}</div>` : ''}
          <form id="reset-form" method="POST" action="/reset-password">
            <input type="hidden" id="access_token" name="access_token" value="">
            <label for="password">New password</label>
            <input type="password" id="password" name="password" required minlength="6" autofocus>
            <label for="confirm_password">Confirm new password</label>
            <input type="password" id="confirm_password" name="confirm_password" required minlength="6">
            <div class="actions" style="margin-top:16px;">
              <button type="submit" class="btn-approve" style="width:100%;">Set password</button>
            </div>
          </form>
        </div>
        <script>
          (function () {
            // The recovery token arrives in the URL fragment (after "#"),
            // e.g. #access_token=xyz&type=recovery — the server never sees
            // this part of the URL, so we have to read it here in the browser.
            var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
            var accessToken = params.get('access_token');
            var form = document.getElementById('reset-form');

            if (!accessToken) {
              document.getElementById('no-token-msg').style.display = 'block';
              form.style.display = 'none';
              return;
            }
            document.getElementById('access_token').value = accessToken;

            form.addEventListener('submit', function (e) {
              var password = document.getElementById('password').value;
              var confirm = document.getElementById('confirm_password').value;
              if (password !== confirm) {
                e.preventDefault();
                alert('Passwords do not match.');
              }
            });
          })();
        </script>
      `,
    })
  );
});

app.post('/reset-password', async (req, res) => {
  const { access_token, password, confirm_password } = req.body;
  const backToForm = (msg) => res.redirect('/reset-password?error=' + encodeURIComponent(msg));

  if (!access_token) {
    return backToForm('This reset link is missing or has expired. Request a new one.');
  }
  if (!password || !confirm_password) {
    return backToForm('Enter and confirm your new password.');
  }
  if (password !== confirm_password) {
    return backToForm('Passwords do not match.');
  }
  if (password.length < 6) {
    return backToForm('Password must be at least 6 characters.');
  }

  try {
    await updatePasswordWithToken(access_token, password);
    res.redirect('/login?notice=' + encodeURIComponent('Your password has been updated — please log in.'));
  } catch (err) {
    backToForm(err.message || 'Could not update your password. Request a new reset link and try again.');
  }
});

// From here on, every route requires a real, verified login.
app.use(requireLogin);

// ---------------------------------------------------------------------
// QUEUE — list of content_items, filterable by status
// ---------------------------------------------------------------------

app.get('/', async (req, res, next) => {
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

    const filterLinks = ['<a href="/"' + (!statusFilter && !archivedFilter ? ' class="active"' : '') + '>All</a>']
      .concat(
        CONTENT_STATUSES.map(
          (s) =>
            `<a href="/?status=${s}"${statusFilter === s ? ' class="active"' : ''}>${s.replace(/_/g, ' ')}</a>`
        )
      )
      .concat([`<a href="/?status=archived"${archivedFilter ? ' class="active"' : ''}>Archived</a>`])
      .join('\n');

    const rows = items
      .map((item) => {
        const inlineFlags = countReviewFlags(item.body);
        const claimFlag = claimFlagsByItem[item.id];
        return `
        <div class="card">
          <div class="item-title"><a href="/items/${item.id}">${escapeHtml(item.title)}</a></div>
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

app.get('/items/:id', async (req, res, next) => {
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
            // id="content-edit-<id>" wrapper so the new "Chat about this
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
    // Edit History entry above via the id="content-edit-<id>" anchors just
    // added to editHistoryHtml.
    //
    // The two edit kinds get visibly distinct badges (blue "Small edit
    // applied" vs. green "Draft revised") — a small, explicit build
    // decision on top of lib/scoped-edit.js's own spec: the AI turn's
    // stored message text already reads differently for the two cases, but
    // the badge itself used to say "Draft revised" for BOTH, which did not
    // actually distinguish them visually. Both classes already exist in
    // lib/layout.js's shared badge CSS (status-ready_for_review = blue,
    // status-approved = green) — no new CSS needed.
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
    // label Peter's own live-appended turns — JSON.stringify escapes
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

            // We don't know yet whether this will be answered directly or
            // trigger a full draft revision (that's the classifier's job on
            // the server) — after a few seconds, say honestly that it might
            // still be a long revision in progress, same spirit as the
            // "Revising with AI..." wait text used elsewhere on this page.
            var slowNoticeTimer = setTimeout(function () {
              chatThinkingText.textContent = "Still working \\u2014 if this turns into a full draft revision it can take 20-90+ seconds. Please don't close this tab.";
            }, 8000);

            generationFetchWithTimeout('/items/' + CHAT_CONFIG.itemId + '/chat', {
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
                  // Same behavior as "Request Changes": a full page reload so
                  // the article body, edit history, and status badges all
                  // reflect the real stored state, rather than a partial
                  // live patch that could drift from what's actually saved.
                  // The flash text itself distinguishes a scoped (single-
                  // passage) edit from a full draft rewrite, matching the
                  // chat log's own badge distinction (see renderChatTurn()).
                  var isScoped = data.aiTurn && data.aiTurn.turn_type === 'edit_scoped';
                  var flashText = isScoped
                    ? 'Small, targeted edit applied — review the updated draft below.'
                    : 'Chat edit applied — the full draft was revised. Review the updated draft below.';
                  window.location.href = '/items/' + CHAT_CONFIG.itemId + '?flash=' + encodeURIComponent(flashText);
                  return;
                }
                // QUESTION — fast path, no regeneration happened. Append both
                // turns in place; nothing else on the page changed.
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

          // Enter sends (Shift+Enter for a newline) — common chat convention;
          // the Send button remains the primary, obvious way to submit.
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
    // has a generated FAQPage JSON-LD block. PostgREST returns jsonb columns
    // already parsed into a real JS value, but this handles a raw JSON
    // string too rather than assuming one shape, in case that ever changes.
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
            <textarea readonly onclick="this.select();" style="min-height:200px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.85rem;">${escapeHtml(scriptBlock)}</textarea>
          </div>
        `;
      } catch (e) {
        // Malformed JSON in the database shouldn't break the whole page —
        // just skip the box rather than crashing the draft detail view.
        console.error(`Could not parse faq_schema for item ${item.id}:`, e);
      }
    }

    // Publish state — either the "mark as published" form (no published_url
    // yet) or a plain link to the already-recorded live URL. Nothing here
    // calls any external publishing API; this only records a URL Peter
    // already published manually, same governance shape as every other
    // action on this page.
    const publishHtml = item.published_url
      ? `
      <div class="card">
        <h3>Published</h3>
        <p style="font-size:0.85rem;color:#666;">This post is marked as published at:</p>
        <p><a href="${escapeHtml(item.published_url)}" target="_blank" rel="noopener">${escapeHtml(item.published_url)}</a></p>
      </div>
      `
      : `
      <div class="card">
        <h3>Mark as Published</h3>
        <p style="font-size:0.85rem;color:#666;">
          Once this post is actually live on the site, paste its web
          address here and save — this only records that it's published;
          it does not publish anything for you.
        </p>
        <form method="POST" action="/items/${item.id}/publish" class="inline-form">
          <label for="published_url">Live URL</label>
          <input type="text" id="published_url" name="published_url" placeholder="https://www.rinconmanagement.com/blog/...">
          <div class="actions">
            <button type="submit" class="btn-approve">Mark as Published</button>
          </div>
        </form>
      </div>
      `;

    // Whole-document edit form (title / body / meta_description) — always available.
    const wholeDocEditForm = `
      <div class="card">
        <h3>Edit this draft</h3>
        <form method="POST" action="/items/${item.id}/edit" class="inline-form">
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

    // Section-level inline editor — only for politically_sensitive items.
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
        <form method="POST" action="/items/${item.id}/section-edit" class="inline-form">
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

    res.send(
      layoutModule.layout({
        title: item.title,
        user: { email: req.session.userEmail },
        flash: req.query.flash ? { type: req.query.flashType || 'success', message: req.query.flash } : null,
        body: `
          <p><a href="/">&larr; Back to queue</a></p>
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
                  ? `<form method="POST" action="/items/${item.id}/unarchive" style="display:inline;">
                      <button type="submit" class="btn-secondary">Unarchive</button>
                    </form>`
                  : `<form method="POST" action="/items/${item.id}/archive" style="display:inline;">
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
                    every claim below has your decision recorded, even if
                    Mason's automatic review already looked at it.
                  </p>
                  <p>
                    <a href="/items/${item.id}/legal-review" class="btn-changes" style="display:inline-block;text-decoration:none;">Review legal claims &rarr;</a>
                  </p>
                </div>`
              : ''
          }

          <div class="card">
            <h3>Decision</h3>
            <div class="actions">
              <form method="POST" action="/items/${item.id}/approve" style="display:inline;">
                <button type="submit" class="btn-approve" ${item.legal_review_status === 'needs_review' ? 'disabled' : ''}>Approve</button>
              </form>
              <form method="POST" action="/items/${item.id}/reject" style="display:inline;" onsubmit="return confirm('Reject this draft?');">
                <button type="submit" class="btn-reject">Reject</button>
              </form>
            </div>
            ${
              item.legal_review_status === 'needs_review'
                ? `<p style="font-size:0.85rem;color:var(--red);margin-top:6px;">
                    Approve is disabled until all legal claims on this draft are reviewed —
                    <a href="/items/${item.id}/legal-review">review legal claims &rarr;</a>
                  </p>`
                : ''
            }
            <form method="POST" action="/items/${item.id}/request-changes" class="inline-form">
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
                  <p><a href="/items/${item.id}/captions" class="btn btn-secondary">Review social captions for this post &rarr;</a></p>
                  <p style="font-size:0.85rem;color:#666;">
                    Need new captions instead? Generating replaces nothing — it
                    just adds 3 new pending captions (Facebook, LinkedIn,
                    Instagram) for you to review.
                  </p>
                  <div class="actions">
                    <a href="/items/${item.id}/captions/generate" class="btn-approve" style="display:inline-block;text-decoration:none;">Generate Social Captions</a>
                  </div>
                </div>`
              : ''
          }

          <div class="safety-note">
            This page only changes the status field on this draft in the database.
            Nothing here posts, publishes, or sends anything anywhere — getting
            approved content live is a manual step Peter does outside this app.
          </div>
          <script src="/generation-fetch.js"></script>
          <script src="/dictation.js"></script>
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

app.post('/items/:id/approve', async (req, res, next) => {
  try {
    // Hard block — checked server-side so this can't be bypassed by posting
    // directly to this route, not just by disabling the Approve button in
    // the UI (see the matching check on POST /items/:id/publish below).
    // Refuses and leaves status untouched; does not change anything.
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');
    if (item.legal_review_status === 'needs_review') {
      return res.redirect(
        `/items/${req.params.id}?flash=${encodeURIComponent('This draft has legal claims pending review — resolve them before approving.')}&flashType=error`
      );
    }

    const updated = await updateOne('content_items', req.params.id, { status: 'approved' });
    if (!updated) return res.status(404).send('Draft not found.');
    res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('Draft approved.')}`);
  } catch (err) {
    next(err);
  }
});

app.post('/items/:id/reject', async (req, res, next) => {
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
    res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('Draft rejected and sent back to draft status.')}&flashType=error`);
  } catch (err) {
    next(err);
  }
});

// Request Changes now does two things in one action: log the feedback, then
// immediately revise the draft with AI using that feedback (plus any prior
// rounds already on this item) — Peter no longer has to come back and click
// a separate "Revise with AI" button. The revision call is a real Claude API
// call (20-30s), so this renders the same "Revising..." interstitial used
// elsewhere, whose own script calls POST .../generate below to do the slow
// work and redirect back to the draft once it's done.
app.post('/items/:id/request-changes', async (req, res, next) => {
  try {
    const { comment } = req.body;
    if (!comment || !comment.trim()) {
      return res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('A comment is required to request changes.')}&flashType=error`);
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
          <form id="retry-form" method="GET" action="/items/${item.id}" style="display:none;"></form>
          <script src="/generation-fetch.js"></script>
          <script>
            (function () {
              generationFetchWithTimeout('/items/${item.id}/request-changes/generate', { method: 'POST' })
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
// logged by POST /items/:id/request-changes above. Same reviseContent() call
// the old standalone "Revise with AI" used — it re-reads all accumulated
// feedback from content_edits itself, so the comment just logged is
// automatically included without needing to be passed through here.
app.post('/items/:id/request-changes/generate', async (req, res) => {
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
      redirect: `/items/${contentItem.id}?flash=${encodeURIComponent('Feedback saved and draft revised — review the updated version below.')}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Revision failed. This is usually a temporary issue — please try again.' });
  }
});

// ---------------------------------------------------------------------
// ARCHIVE / UNARCHIVE — hides/shows an item from the default queue view.
// Independent of approval status: archiving never touches the `status`
// field, only `archived`. Same as every other action here, this only
// changes a field in the database and logs it — nothing is sent, posted,
// or published.
// ---------------------------------------------------------------------

app.post('/items/:id/archive', async (req, res, next) => {
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
    res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('Draft archived — hidden from the main queue.')}`);
  } catch (err) {
    next(err);
  }
});

app.post('/items/:id/unarchive', async (req, res, next) => {
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
    res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('Draft unarchived — back in the main queue.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// PUBLISH — one-time action that records the live URL once a post has
// actually gone out (a manual step Peter does outside this app). Same
// governance shape as every other action in this file: this only sets
// status + published_url on the row and logs it, exactly like approve/
// reject/archive. It never calls any external publishing API — it only
// records that publishing already happened somewhere else.
// ---------------------------------------------------------------------

app.post('/items/:id/publish', async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');

    // Same hard block as POST /items/:id/approve above — server-side, so
    // posting directly to this route can't bypass it either. Refuses and
    // leaves status/published_url untouched.
    if (item.legal_review_status === 'needs_review') {
      return res.redirect(
        `/items/${req.params.id}?flash=${encodeURIComponent('This draft has legal claims pending review — resolve them before publishing.')}&flashType=error`
      );
    }

    const publishedUrl = (req.body.published_url || '').trim();
    if (!publishedUrl) {
      return res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('Enter the live URL to mark this as published.')}&flashType=error`);
    }
    if (!/^https?:\/\//i.test(publishedUrl)) {
      return res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('That does not look like a valid web address — it should start with http:// or https://.')}&flashType=error`);
    }

    let updated;
    try {
      updated = await updateOne('content_items', req.params.id, {
        status: 'published',
        published_url: publishedUrl,
      });
    } catch (updateErr) {
      // published_url has a UNIQUE constraint (uq_content_items_published_url) —
      // if Peter pastes a URL already recorded on a different post, PostgREST
      // rejects the write with a 23505 "duplicate key" error. Catch just that
      // specific case and send him back with a friendly explanation instead
      // of letting it fall through to the generic error page; any other kind
      // of failure still goes to next(err) as a real error.
      const isDuplicateUrl =
        updateErr.message &&
        (updateErr.message.includes('23505') ||
          updateErr.message.includes('duplicate key value violates unique constraint'));
      if (isDuplicateUrl) {
        return res.redirect(
          `/items/${req.params.id}?flash=${encodeURIComponent('That web address is already linked to a different post — double check the URL, or use a different one.')}&flashType=error`
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

    res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('Marked as published.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// LEGAL REVIEW — the page the "Legal review needed" card above links to.
// Lists every legal_claim_reviews row for this article (a legal claim the
// AI researched and sourced itself, outside Rincon's verified
// compliance_claims knowledge base) and lets Peter record his own decision
// on each one. Mason's automatic finding (mason_finding/mason_note) is
// shown as an input to that decision, never as a substitute for it — see
// content-engine/lib/legal-review.js and the migration's own header comment
// for why those stay two separate columns. Same governance shape as every
// other route in this file: only reads/writes Supabase fields, never
// publishes, sends, or posts anything anywhere.
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

// isSafeHttpUrl-style guard, same reasoning as lib/highlight.js: a
// legal_claim_reviews.source_url can be a placeholder string like
// "(no source found in article text — flagged for review)" rather than a
// real link — only render an actual <a href> when it's genuinely http(s).
function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

app.get('/items/:id/legal-review', async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');

    const claims = await select(
      'legal_claim_reviews',
      `select=*&content_item_id=eq.${item.id}&order=created_at.asc`
    );

    // Unresolved rows first (peter_decision NULL or 'consulting_attorney'),
    // matching RESOLVED_PETER_DECISIONS from content-engine/lib/legal-review.js
    // — the same definition of "resolved" recomputeLegalReviewStatus() uses,
    // so this page's ordering can never disagree with what actually gates
    // Approve/Publish.
    const sortedClaims = claims.slice().sort((a, b) => {
      const aResolved = RESOLVED_PETER_DECISIONS.includes(a.peter_decision) ? 1 : 0;
      const bResolved = RESOLVED_PETER_DECISIONS.includes(b.peter_decision) ? 1 : 0;
      return aResolved - bResolved;
    });

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

              <form method="POST" action="/items/${item.id}/legal-review/${c.id}/decide" class="inline-form">
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
              </form>
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
          <p><a href="/items/${item.id}">&larr; Back to draft</a></p>
          <h2>Legal review — ${escapeHtml(item.title)}</h2>
          <p style="font-size:0.9rem;color:#666;">
            These are legal claims the AI researched and sourced itself while
            writing this draft — they are not part of Rincon's pre-verified
            legal knowledge base, so each one needs your explicit decision
            before the draft can be approved or published. Mason's automatic
            review below is his judgment on the claim and its source; it is
            an input to your decision, not a substitute for it.
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

app.post('/items/:id/legal-review/:reviewId/decide', async (req, res, next) => {
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
      return res.redirect(`/items/${id}/legal-review?flash=${encodeURIComponent('Choose a decision before saving.')}&flashType=error`);
    }
    if (peter_decision === 'approved_with_edit' && !peterEditedText) {
      return res.redirect(`/items/${id}/legal-review?flash=${encodeURIComponent('Enter your replacement text for "Approve with my edit."')}&flashType=error`);
    }

    const patch = {
      peter_decision,
      peter_edited_text: peter_decision === 'approved_with_edit' ? peterEditedText : null,
      decided_by: req.session.userEmail,
      decided_at: new Date().toISOString(),
    };
    await updateOne('legal_claim_reviews', reviewId, patch);

    // Audit trail — same content_edits convention every other action in
    // this file uses (field_changed / before_text / after_text / edit_note),
    // per this build's spec: field_changed = 'legal_review'.
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

    res.redirect(`/items/${id}/legal-review?flash=${encodeURIComponent('Decision saved.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Whole-document edit (title / body / meta_description) -> content_edits
// ---------------------------------------------------------------------

app.post('/items/:id/edit', async (req, res, next) => {
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

    res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('Edits saved.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Section-level edit (politically_sensitive items only) -> content_section_edits
// ---------------------------------------------------------------------

app.post('/items/:id/section-edit', async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');
    if (!item.politically_sensitive) {
      return res.status(400).send('Section-level editing is only available for politically sensitive content.');
    }

    const { section_label, before_text, after_text, reason } = req.body;
    if (!section_label || !before_text || !after_text) {
      return res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('Section, before text, and after text are all required.')}&flashType=error`);
    }

    await insert('content_section_edits', {
      content_item_id: req.params.id,
      section_label,
      edited_by: req.session.userEmail,
      before_text,
      after_text,
      reason: reason || null,
    });

    // If the edited text appears in the body verbatim, apply it there too so
    // the draft reflects the change, and log it in content_edits as well.
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

    res.redirect(`/items/${req.params.id}?flash=${encodeURIComponent('Section edit saved.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// CHAT — a real back-and-forth conversation on a draft, replacing the old
// one-shot "leave a comment -> whole article gets rewritten" flow with
// something that can tell a QUESTION ("why won't you use my sources") apart
// from a genuine EDIT request. Backend/logic layer only in this stage — no
// chat panel UI yet (that's Tron's build, on top of this route). Returns
// JSON (called via fetch, same shape as /request-changes/generate and
// /ideas/generate below) rather than redirecting, since a real chat UI reads
// the new turn(s) back to render them without a full page reload.
//
// This is a real Claude call (intent classification), and for an EDIT
// message, a second real Claude-backed call (the existing reviseContent()
// pipeline, unchanged — same 20-30s full-document rewrite the old "Request
// Changes" button already triggers). Same governance shape as every other
// route in this file: only reads/writes Supabase fields, never publishes,
// sends, or posts anything anywhere.
// ---------------------------------------------------------------------

app.post('/items/:id/chat', async (req, res) => {
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
// SUBMIT AN IDEA — self-serve draft request, no CLI needed.
//
// GET /ideas/new    shows the form (title, brief, content type, topics)
// POST /ideas/new    validates input, then renders a "Generating..." page
// POST /ideas/generate  the interstitial page's own script calls this via
//                       fetch() to actually run the (slow, ~20-30s) Claude
//                       generation and get back the new draft's id
//
// This calls content-engine's draftContent() directly — the exact same
// function draft-content.js's CLI uses — so the prompt/grounding logic is
// never duplicated here. It only ever creates a content_items row with
// status='draft'; nothing here publishes, sends, or posts anything, and the
// resulting draft goes through the exact same review queue and approval
// workflow as any other draft.
// ---------------------------------------------------------------------

app.get('/ideas/new', async (req, res, next) => {
  try {
    const error = req.query.error ? escapeHtml(req.query.error) : null;

    // Pre-fill support: reached via /topics "Approve" redirect, which passes
    // the approved topic_suggestion's summary/note as a starting point, plus
    // the suggestion's id so the resulting draft can be linked back to it
    // (see source_topic_suggestion_id below and /ideas/generate).
    const prefillTitle = req.query.title ? escapeHtml(req.query.title) : '';
    const prefillBrief = req.query.brief ? escapeHtml(req.query.brief) : '';
    const sourceTopicSuggestionId = req.query.source_topic_suggestion_id
      ? escapeHtml(req.query.source_topic_suggestion_id)
      : null;

    const contentTypeOptions = VALID_CONTENT_TYPES.map(
      (t) => `<option value="${t}">${escapeHtml(t.replace(/_/g, ' '))}</option>`
    ).join('\n');

    // Pull the real topic_key values from the compliance knowledge base so
    // Peter picks from an actual, current list rather than typing raw keyword
    // slugs he's never seen (e.g. "ab-1482-statewide-and-local-variation").
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
          normal review queue for you to approve, edit, or reject.
        </p>
        ${error ? `<div class="flash error">${error}</div>` : ''}
        <div class="card">
          <form method="POST" action="/ideas/new">
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
        <script src="/dictation.js"></script>
      `,
    })
  );
  } catch (err) {
    next(err);
  }
});

app.post('/ideas/new', async (req, res, next) => {
  try {
    const { title, brief, content_type, inspiration_piece, source_topic_suggestion_id } = req.body;
    const topics = req.body.topics
      ? (Array.isArray(req.body.topics) ? req.body.topics : [req.body.topics])
      : [];
    // Optional one-off style reference for this draft only — never saved
    // anywhere, just carried through this interstitial page to POST
    // /ideas/generate below, then discarded once the Claude call returns.
    const inspirationPiece =
      inspiration_piece && inspiration_piece.trim() ? inspiration_piece.trim() : null;
    // Present only when this idea started from an approved topic suggestion
    // (see /topics/:id/approve's redirect into /ideas/new). Carried through
    // the same way inspirationPiece is, so /ideas/generate can link the
    // resulting draft back to the suggestion that inspired it.
    const sourceTopicSuggestionId =
      typeof source_topic_suggestion_id === 'string' && source_topic_suggestion_id.trim()
        ? source_topic_suggestion_id.trim()
        : null;

    if (!title || !title.trim()) {
      return res.redirect('/ideas/new?error=' + encodeURIComponent('A working title is required.'));
    }
    if (!brief || !brief.trim()) {
      return res.redirect('/ideas/new?error=' + encodeURIComponent('Please describe what the piece should cover.'));
    }
    if (!VALID_CONTENT_TYPES.includes(content_type)) {
      return res.redirect('/ideas/new?error=' + encodeURIComponent('Please choose a content type.'));
    }

    // Render the "generating" interstitial. Its own inline script calls
    // POST /ideas/generate with the same form data — generation typically
    // takes 20-30 seconds (a real Claude API call plus a database lookup),
    // long enough that submitting straight to a slow POST would leave the
    // browser looking frozen with no feedback.
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
          <form id="retry-form" method="GET" action="/ideas/new" style="display:none;"></form>
          <script src="/generation-fetch.js"></script>
          <script>
            (function () {
              // JSON.stringify does not escape the HTML closing-script
              // sequence, so a pasted inspiration piece containing that
              // exact sequence could otherwise break out of this inline
              // script tag. Escaping "</" to "<\/" keeps it valid JSON
              // (JS ignores the backslash before "/") while making it
              // unable to close the tag. NOTE: this comment must never
              // spell out the literal sequence itself, or it recreates
              // the exact bug it is describing.
              var payload = ${JSON.stringify({
                title: title.trim(),
                brief: brief.trim(),
                content_type,
                topics,
                inspiration_piece: inspirationPiece,
                source_topic_suggestion_id: sourceTopicSuggestionId,
              }).replace(/<\//g, '<\\/')};
              generationFetchWithTimeout('/ideas/generate', {
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

app.post('/ideas/generate', async (req, res) => {
  try {
    const { title, brief, content_type, topics, inspiration_piece, source_topic_suggestion_id } = req.body;

    if (!title || !brief || !VALID_CONTENT_TYPES.includes(content_type) || !Array.isArray(topics)) {
      return res.status(400).json({ error: 'Missing or invalid idea details.' });
    }

    // Passed straight into the prompt as a style reference and never
    // written to the database — see draftContent()'s inspirationPiece
    // param in content-engine/lib/draft.js for exactly how it's used.
    const inspirationPiece =
      typeof inspiration_piece === 'string' && inspiration_piece.trim()
        ? inspiration_piece.trim()
        : null;

    // Present only when this idea started from an approved topic suggestion
    // (threaded through from /ideas/new's hidden form field). Written to
    // content_items.source_topic_suggestion_id by draftContent() so the
    // resulting draft links back to the suggestion that inspired it.
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

    res.json({ redirect: `/items/${contentItem.id}?flash=${encodeURIComponent('Draft generated — review it below.')}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Draft generation failed. This is usually a temporary issue — please try again.' });
  }
});

// ---------------------------------------------------------------------
// BRAND VOICE GUIDE — self-serve upload/version history for the standing
// voice/style guide that content-engine's draftContent() and reviseContent()
// now read on every generation (see content-engine/lib/brand-guide.js).
//
// brand_guides keeps history as rows, not in-place edits: "a new version is
// a new row; the most recent row is the active guide" (see the migration
// comment). Saving here always INSERTs a new row — it never UPDATEs an
// existing one — so nothing is ever destroyed, and Peter can see what
// changed over time.
//
// Same governance shape as everything else in this app: this only reads
// from and writes a text field to Supabase. Nothing here calls any
// external API, and the guide content itself is never treated as a source
// of legal facts anywhere it's used (see the "BRAND VOICE GUIDE" prompt
// block in content-engine/lib/brand-guide.js for that safety wording).
// ---------------------------------------------------------------------

app.get('/brand-guide', async (req, res, next) => {
  try {
    // Rows with content=NULL (the original seed row, or any bad insert)
    // don't count as a real version — filter them out so both "current"
    // and "history" only ever reflect guides Peter actually wrote.
    const rows = await select(
      'brand_guides',
      'select=*&content=not.is.null&order=created_at.desc'
    );
    const current = rows[0] || null;
    const history = rows.slice(1);

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
          <div class="empty-state">You haven't added a brand voice guide yet. Use the form below to add one — it will automatically be used to guide the voice and style of every draft generated from now on.</div>
        </div>`;

    const historyBlock = history.length
      ? `
        <div class="card">
          <h3>Version history</h3>
          ${history
            .map(
              (h, i) => `
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

          <div class="card">
            <h3>${current ? 'Edit and save a new version' : 'Add your brand voice guide'}</h3>
            <p style="font-size:0.85rem;color:#666;">
              ${
                current
                  ? "This textarea is pre-filled with the current guide — edit it and save to create a new version. Saving does not overwrite the current guide; it adds a new version and keeps the old one in the history below, so you can always see what changed."
                  : 'Describe how Rincon\'s content should sound — tone, vocabulary, sentence style, structure preferences. This guides voice and style only; it will never be used as a source of facts.'
              }
            </p>
            <form method="POST" action="/brand-guide" class="inline-form">
              <label for="content">Brand voice guide content</label>
              <textarea id="content" name="content" required style="min-height:260px;" placeholder="Describe Rincon's voice: tone, vocabulary to use or avoid, sentence style, formatting preferences, examples of good phrasing, etc.">${current ? escapeHtml(current.content) : ''}</textarea>
              <label for="notes">Notes about this version (optional)</label>
              <input type="text" id="notes" name="notes" placeholder="e.g. Added guidance on avoiding jargon">
              <div class="actions">
                <button type="submit" class="btn-approve">Save as new version</button>
              </div>
            </form>
          </div>

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

app.post('/brand-guide', async (req, res, next) => {
  try {
    const { content, notes } = req.body;
    if (!content || !content.trim()) {
      return res.redirect(`/brand-guide?flash=${encodeURIComponent('Brand guide content is required.')}&flashType=error`);
    }
    await insert('brand_guides', {
      guide_name: 'default',
      content: content.trim(),
      notes: notes && notes.trim() ? notes.trim() : null,
    });
    res.redirect(`/brand-guide?flash=${encodeURIComponent('Brand voice guide saved as a new version.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// TOPIC SUGGESTIONS queue
// ---------------------------------------------------------------------

// Friendly display labels for feed_source slugs — same idea as TOPIC_LABELS
// above, so the scan-status line reads in plain English instead of a
// database slug.
const FEED_SOURCE_LABELS = {
  legislative_trend_forum_scan: 'legislative trend scan',
  viral_trend_scan: 'viral trend scan',
  civic_council_monitoring: 'civic council monitoring',
};

app.get('/topics', async (req, res, next) => {
  try {
    // Same archive convention as the main draft queue (see "/" above):
    // ?status=archived shows ONLY archived topics; otherwise archived
    // topics stay hidden from the normal pending/decided lists.
    const archivedFilter = req.query.status === 'archived';
    const topics = await select(
      'topic_suggestions',
      archivedFilter ? 'select=*&archived=eq.true&order=created_at.desc' : 'select=*&archived=eq.false&order=created_at.desc'
    );
    const pending = topics.filter((t) => t.status === 'pending');
    const decided = topics.filter((t) => t.status !== 'pending');

    // Most recent run per feed_source, so the page can show "last scan:
    // succeeded / failed" instead of a silent failure. Rows are already
    // ordered newest-first by ran_at, so the first row seen per feed is
    // its most recent run — no need for a separate query per feed.
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
                <form method="POST" action="/topics/${t.id}/approve" style="display:inline;">
                  <button type="submit" class="btn-approve">Approve</button>
                </form>
                <form method="POST" action="/topics/${t.id}/reject" style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:200px;">
                  <input type="text" name="rejection_note" placeholder="Why? (optional)">
                  <button type="submit" class="btn-reject">Reject</button>
                </form>
              </div>`
            : `
              ${t.rejection_note ? `<p class="item-meta">Rejection note: ${escapeHtml(t.rejection_note)}</p>` : ''}
              <div class="actions">
                ${
                  t.archived
                    ? `<form method="POST" action="/topics/${t.id}/unarchive" style="display:inline;">
                        <button type="submit" class="btn-secondary">Unarchive</button>
                      </form>`
                    : `<form method="POST" action="/topics/${t.id}/archive" style="display:inline;">
                        <button type="submit" class="btn-secondary">Archive</button>
                      </form>`
                }
              </div>`
        }
      </div>`;

    const filterLinks = [
      `<a href="/topics"${!archivedFilter ? ' class="active"' : ''}>All</a>`,
      `<a href="/topics?status=archived"${archivedFilter ? ' class="active"' : ''}>Archived</a>`,
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
            scans, viral trend scans, civic council monitoring). This queue is
            ready — the feeds that populate it are a future build, so it may
            be empty right now.
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

app.post('/topics/:id/approve', async (req, res, next) => {
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
    res.redirect(`/ideas/new?${params.toString()}`);
  } catch (err) {
    next(err);
  }
});

app.post('/topics/:id/reject', async (req, res, next) => {
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
    res.redirect(`/topics?flash=${encodeURIComponent('Topic rejected.')}&flashType=error`);
  } catch (err) {
    next(err);
  }
});

// ARCHIVE / UNARCHIVE — hides/shows a decided topic from the default
// /topics view. Same shape as the content_items archive above: only
// changes the `archived` field, never `status`. Approve/reject on this
// table don't log to any edit-history table, so this doesn't either.
app.post('/topics/:id/archive', async (req, res, next) => {
  try {
    const updated = await updateOne('topic_suggestions', req.params.id, { archived: true });
    if (!updated) return res.status(404).send('Topic not found.');
    res.redirect(`/topics?flash=${encodeURIComponent('Topic archived.')}`);
  } catch (err) {
    next(err);
  }
});

app.post('/topics/:id/unarchive', async (req, res, next) => {
  try {
    const updated = await updateOne('topic_suggestions', req.params.id, { archived: false });
    if (!updated) return res.status(404).send('Topic not found.');
    res.redirect(`/topics?flash=${encodeURIComponent('Topic unarchived.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// LEGAL UPDATES — review queue for legal_update_candidates: California
// bills the LegiScan scan found that have been chaptered (signed into
// law). This is a TRIAGE queue only. Approving/rejecting a row here just
// records a human verdict on review_status — it never touches
// compliance_claims and never sets resulting_claim_id. See the migration
// (20260715000000_legal_update_candidate_scan.sql) for the two-step rule
// this enforces: a separate, later step (writing a real compliance_claims
// row, outside this page's scope) is what actually makes a candidate a
// citable legal fact. A row can be "approved" here with
// resulting_claim_id still NULL indefinitely — that is a normal, expected
// state, not a bug, and the page below says so explicitly.
//
// legal_update_candidates.topic_id is a direct FK to compliance_topics.id
// (not a topic_key string), so the query below embeds compliance_topics
// via PostgREST's nested-resource syntax to get topic_key, then maps that
// through the existing TOPIC_LABELS/topicLabel() helper used on /topics
// and /ideas/new. When topic_id is NULL, PostgREST returns a null embed
// and the label is simply omitted.
// ---------------------------------------------------------------------

const LEGAL_UPDATE_STATUSES = ['pending', 'approved', 'rejected'];

app.get('/legal-updates', async (req, res, next) => {
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

      // Claim-written status — the whole point of this being a separate,
      // visible signal from review_status (see the big comment above).
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
                <form method="POST" action="/legal-updates/${c.id}/approve" style="display:inline;">
                  <button type="submit" class="btn-approve">Approve</button>
                </form>
                <form method="POST" action="/legal-updates/${c.id}/reject" style="display:flex;flex-direction:column;gap:6px;flex:1;min-width:200px;">
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
      `<a href="/legal-updates"${statusFilter === 'pending' ? ' class="active"' : ''}>Pending</a>`,
      `<a href="/legal-updates?status=approved"${statusFilter === 'approved' ? ' class="active"' : ''}>Approved</a>`,
      `<a href="/legal-updates?status=rejected"${statusFilter === 'rejected' ? ' class="active"' : ''}>Rejected</a>`,
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
            automatically. Approving one here just means &ldquo;worth Mason
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

app.post('/legal-updates/:id/approve', async (req, res, next) => {
  try {
    const updated = await updateOne('legal_update_candidates', req.params.id, {
      review_status: 'approved',
      reviewed_by: req.session.userEmail,
      reviewed_at: new Date().toISOString(),
    });
    if (!updated) return res.status(404).send('Candidate not found.');
    res.redirect(
      `/legal-updates?flash=${encodeURIComponent("Marked as worth writing up — still needs a real legal claim entry before it's usable.")}`
    );
  } catch (err) {
    next(err);
  }
});

app.post('/legal-updates/:id/reject', async (req, res, next) => {
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
    res.redirect(`/legal-updates?flash=${encodeURIComponent('Candidate rejected.')}&flashType=error`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// SOCIAL CAPTIONS review, per approved blog post
// ---------------------------------------------------------------------

app.get('/items/:id/captions', async (req, res, next) => {
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
                  <form method="POST" action="/captions/${c.id}/approve" style="display:inline;">
                    <button type="submit" class="btn-approve">Approve</button>
                  </form>
                  <form method="POST" action="/captions/${c.id}/reject" style="display:inline;">
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
          <p><a href="/items/${item.id}">&larr; Back to draft</a></p>
          <h2>Social captions for: ${escapeHtml(item.title)}</h2>
          ${captionsHtml}
          <div class="safety-note">
            Approving a caption here only marks it approved in the database.
            Nobody posts it automatically — copying it to Facebook, LinkedIn,
            or Instagram is a manual step Peter's team does outside this app.
          </div>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

// Both routes below work for captions linked to a blog post (redirect back
// to that post's captions page) and standalone captions with no parent item
// (redirect back to that submission's batch page) — same actions, same
// social_captions table, just a different "back to" destination depending
// on whether content_item_id is set.
function captionReturnUrl(caption) {
  return caption.content_item_id
    ? `/items/${caption.content_item_id}/captions`
    : `/social/batches/${caption.batch_id}`;
}

app.post('/captions/:id/approve', async (req, res, next) => {
  try {
    const caption = await updateOne('social_captions', req.params.id, { status: 'approved' });
    if (!caption) return res.status(404).send('Caption not found.');
    res.redirect(`${captionReturnUrl(caption)}?flash=${encodeURIComponent('Caption approved.')}`);
  } catch (err) {
    next(err);
  }
});

app.post('/captions/:id/reject', async (req, res, next) => {
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
// detail page. Same interstitial pattern as "Submit an Idea" / "Revise with
// AI": GET renders a "Generating..." page whose own script calls the POST
// endpoint to do the actual (slow, ~10-20s) Claude call, then redirects to
// the captions review page.
//
// This calls content-engine's generateCaptions() directly — the exact same
// function generate-captions.js's CLI uses — no duplicated prompt logic.
// It only ever inserts pending rows into social_captions; nothing here
// publishes, sends, or posts anything.
// ---------------------------------------------------------------------

app.get('/items/:id/captions/generate', async (req, res, next) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).send('Draft not found.');
    if (item.content_type !== 'blog_post' || item.status !== 'approved') {
      return res.redirect(
        `/items/${item.id}?flash=${encodeURIComponent('Social captions can only be generated for approved blog posts.')}&flashType=error`
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
          <form id="retry-form" method="GET" action="/items/${item.id}" style="display:none;"></form>
          <script src="/generation-fetch.js"></script>
          <script>
            (function () {
              generationFetchWithTimeout('/items/${item.id}/captions/generate', { method: 'POST' })
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

app.post('/items/:id/captions/generate', async (req, res) => {
  try {
    const item = await selectOne('content_items', req.params.id);
    if (!item) return res.status(404).json({ error: 'Draft not found.' });
    if (item.content_type !== 'blog_post' || item.status !== 'approved') {
      return res.status(400).json({ error: 'Social captions can only be generated for approved blog posts.' });
    }

    await timeGeneration(`generateCaptions item=${item.id}`, () => generateCaptions(item.id));

    res.json({
      redirect: `/items/${item.id}/captions?flash=${encodeURIComponent('3 new captions generated — review them below.')}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Caption generation failed. This is usually a temporary issue — please try again.' });
  }
});

// ---------------------------------------------------------------------
// STANDALONE SOCIAL POSTS — create social captions with no parent blog
// post. Submitting a topic/brief here generates 3 platform captions
// (Facebook/LinkedIn/Instagram) with content_item_id = NULL, grouped by a
// shared batch_id and labeled with the topic title, same grounding/safety
// rules as every other generation path in this app (draftContent /
// generateCaptions). Same interstitial pattern as "Submit an Idea".
//
// GET  /social/new           shows the form (title, brief, topics, inspiration)
// POST /social/new           validates, then renders the "Generating..." page
// POST /social/generate      the interstitial page's script calls this to do
//                             the actual (slow) Claude call and get a batch_id back
// GET  /social/batches       lists all standalone caption batches, grouped
// GET  /social/batches/:id   review one batch's 3 captions (approve/reject)
// ---------------------------------------------------------------------

app.get('/social/new', async (req, res, next) => {
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
            captions queue for you to approve, edit, or reject.
          </p>
          ${error ? `<div class="flash error">${error}</div>` : ''}
          <div class="card">
            <form method="POST" action="/social/new">
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
          <script src="/dictation.js"></script>
        `,
      })
    );
  } catch (err) {
    next(err);
  }
});

app.post('/social/new', async (req, res, next) => {
  try {
    const { title, brief, inspiration_piece } = req.body;
    const topics = req.body.topics
      ? (Array.isArray(req.body.topics) ? req.body.topics : [req.body.topics])
      : [];
    const inspirationPiece =
      inspiration_piece && inspiration_piece.trim() ? inspiration_piece.trim() : null;

    if (!title || !title.trim()) {
      return res.redirect('/social/new?error=' + encodeURIComponent('A topic / working title is required.'));
    }
    if (!brief || !brief.trim()) {
      return res.redirect('/social/new?error=' + encodeURIComponent('Please describe what these captions should cover.'));
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
          <form id="retry-form" method="GET" action="/social/new" style="display:none;"></form>
          <script src="/generation-fetch.js"></script>
          <script>
            (function () {
              // See /ideas/new's identical comment: escaping "</" keeps this
              // valid even if a pasted inspiration piece contains the HTML
              // closing-script sequence (never spell that sequence out
              // literally in this comment — doing so recreates the bug).
              var payload = ${JSON.stringify({
                title: title.trim(),
                brief: brief.trim(),
                topics,
                inspiration_piece: inspirationPiece,
              }).replace(/<\//g, '<\\/')};
              generationFetchWithTimeout('/social/generate', {
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

app.post('/social/generate', async (req, res) => {
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
      redirect: `/social/batches/${batchId}?flash=${encodeURIComponent('3 captions generated — review them below.')}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Caption generation failed. This is usually a temporary issue — please try again.' });
  }
});

app.get('/social/batches', async (req, res, next) => {
  try {
    // Every standalone caption row carries a batch_id — group by it here so
    // the 3 platform variants from one submission show as one row in this
    // list, not as disconnected captions.
    //
    // Archive filtering happens right in this query, same convention as the
    // main draft queue and /topics: ?status=archived shows ONLY archived
    // batches, otherwise archived ones stay hidden. Archiving a batch always
    // sets `archived` on every one of its rows together (see the
    // /social/batches/:batchId/archive route below), so filtering the raw
    // caption rows by `archived` here already yields whole batches, not
    // partial ones — no separate "is this batch fully archived" check needed.
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
      // Keep the earliest created_at / most complete label for display.
      if (c.created_at < batches[c.batch_id].created_at) batches[c.batch_id].created_at = c.created_at;
    }

    const batchList = Object.values(batches).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const rows = batchList
      .map((b) => {
        const pendingCount = b.captions.filter((c) => c.status === 'pending').length;
        const isArchived = b.captions.every((c) => c.archived);
        return `
        <div class="card">
          <div class="item-title"><a href="/social/batches/${b.batch_id}">${escapeHtml(b.topic_label || 'Untitled social post')}</a></div>
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
      `<a href="/social/batches"${!archivedFilter ? ' class="active"' : ''}>All</a>`,
      `<a href="/social/batches?status=archived"${archivedFilter ? ' class="active"' : ''}>Archived</a>`,
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
            <a href="/social/new">New Social Post</a>), grouped by submission.
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

app.get('/social/batches/:batchId', async (req, res, next) => {
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
                <form method="POST" action="/captions/${c.id}/approve" style="display:inline;">
                  <button type="submit" class="btn-approve">Approve</button>
                </form>
                <form method="POST" action="/captions/${c.id}/reject" style="display:inline;">
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
          <p><a href="/social/batches">&larr; Back to standalone social posts</a></p>
          <h2>Social captions for: ${escapeHtml(topicLabelText)}</h2>
          <div>
            ${isArchived ? '<span class="badge sensitive">archived</span>' : ''}
          </div>
          ${captionsHtml}
          <div class="safety-note">
            Approving a caption here only marks it approved in the database.
            Nobody posts it automatically — copying it to Facebook, LinkedIn,
            or Instagram is a manual step Peter's team does outside this app.
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
                  ? `<form method="POST" action="/social/batches/${req.params.batchId}/unarchive" style="display:inline;">
                      <button type="submit" class="btn-secondary">Unarchive</button>
                    </form>`
                  : `<form method="POST" action="/social/batches/${req.params.batchId}/archive" style="display:inline;">
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

// ARCHIVE / UNARCHIVE a whole standalone social batch — a batch isn't a
// single row, it's every social_captions row sharing this batch_id, so
// this does one bulk UPDATE covering all of them together rather than
// looping row by row. That keeps the whole batch's archived state moving
// atomically as one unit, same as the comment on GET /social/batches
// above explains. No caption `status` fields are touched.
app.post('/social/batches/:batchId/archive', async (req, res, next) => {
  try {
    const updated = await update('social_captions', `batch_id=eq.${req.params.batchId}`, { archived: true });
    if (updated.length === 0) return res.status(404).send('Social post batch not found.');
    res.redirect(`/social/batches/${req.params.batchId}?flash=${encodeURIComponent('Batch archived — hidden from the main list.')}`);
  } catch (err) {
    next(err);
  }
});

app.post('/social/batches/:batchId/unarchive', async (req, res, next) => {
  try {
    const updated = await update('social_captions', `batch_id=eq.${req.params.batchId}`, { archived: false });
    if (updated.length === 0) return res.status(404).send('Social post batch not found.');
    res.redirect(`/social/batches/${req.params.batchId}?flash=${encodeURIComponent('Batch unarchived — back in the main list.')}`);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------

app.use((err, req, res, next) => {
  // Log the real error server-side (may include raw database details like
  // constraint names or Postgres error codes), but never send those details
  // to the browser — show a generic message instead.
  console.error(err);
  res.status(500).send(`
    <html><body style="font-family:sans-serif;padding:40px;">
      <h2>Something went wrong</h2>
      <p>Sorry, something went wrong on our end. Please try again, and let Peter know if it keeps happening.</p>
      <p><a href="/">Back to the draft queue</a></p>
    </body></html>
  `);
});

app.listen(PORT, () => {
  console.log(`Rincon Content Review running at http://localhost:${PORT}`);
  console.log(`Log in with the account created by scripts/create-first-user.js`);
});
