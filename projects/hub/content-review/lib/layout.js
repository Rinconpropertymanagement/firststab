/**
 * lib/layout.js
 * Plain string-template HTML layout — copied from projects/content-review/
 * lib/layout.js (that file is not touched; the standalone app keeps working
 * on its own copy). Same CSS, same page shape. Three things changed for the
 * Hub:
 *   1. Every nav link and the "Log out" link are prefixed/repointed for
 *      where this tool now lives — see the nav block below.
 *   2. The Hub's shared "search properties" widget (../lib/global-search-
 *      widget.js) is injected right after <body>, same as every other Hub
 *      tool's page — see GLOBAL_SEARCH_WIDGET_HTML below.
 *   3. A "← Rincon Hub" link is added next to the brand name, matching the
 *      back-link convention every other Hub tool's dashboard uses.
 * No CSS or page-shape changes beyond that — this is a port, not a redesign.
 */

const { GLOBAL_SEARCH_WIDGET_HTML } = require('../../lib/global-search-widget');

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout({ title, body, user, flash }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — Rincon Content Review</title>
<style>
  :root {
    --blue: #1a56db;
    --green: #0f9d58;
    --red: #d93025;
    --yellow: #b45309;
    --gray-bg: #f5f6f8;
    --border: #dcdfe4;
  }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    margin: 0;
    background: var(--gray-bg);
    color: #1b1f23;
    line-height: 1.5;
  }
  header.topbar {
    background: #fff;
    border-bottom: 1px solid var(--border);
    padding: 12px 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  header.topbar .brand { font-weight: 700; font-size: 1.1rem; }
  header.topbar .brand a.back-to-hub { font-weight: 400; font-size: 0.8rem; color: #666; text-decoration: none; margin-right: 10px; }
  header.topbar .brand a.back-to-hub:hover { text-decoration: underline; }
  header.topbar nav a {
    margin-right: 14px;
    text-decoration: none;
    color: #333;
    font-size: 0.95rem;
  }
  header.topbar nav a:hover { text-decoration: underline; }
  header.topbar .user-info { font-size: 0.85rem; color: #666; }
  main {
    max-width: 900px;
    margin: 0 auto;
    padding: 16px;
  }
  .flash {
    padding: 12px 16px;
    border-radius: 8px;
    margin-bottom: 16px;
    font-size: 0.95rem;
  }
  .flash.success { background: #e6f4ea; color: var(--green); border: 1px solid #b7e1c3; }
  .flash.error { background: #fce8e6; color: var(--red); border: 1px solid #f5c2be; }
  .card {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 14px;
  }
  .card h3 { margin-top: 0; }
  .badge {
    display: inline-block;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    margin-right: 6px;
    white-space: nowrap;
  }
  .badge.status-draft { background: #eee; color: #555; }
  .badge.status-ready_for_review { background: #e8f0fe; color: var(--blue); }
  .badge.status-needs_changes { background: #fef7e0; color: var(--yellow); }
  .badge.status-approved { background: #e6f4ea; color: var(--green); }
  .badge.status-published { background: #e6f4ea; color: var(--green); }
  .badge.status-rejected { background: #fce8e6; color: var(--red); }
  .badge.status-pending { background: #eee; color: #555; }
  .badge.sensitive { background: #fef3e6; color: #b45309; border: 1px solid #f5d9a8; }
  .badge.needs-review { background: #fce8e6; color: var(--red); border: 1px solid #f5c2be; }
  .badge.ai-source { background: #f2ebfd; color: #6b46c1; border: 1px solid #ddc8f5; }
  .badge.ai-quote-badge { background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; }
  /* Legal-review-checkpoint badges — blue on purpose, so this reads as a
     distinct third meaning from the amber "sensitive" and red "needs
     review" badges above (see lib/highlight.js's header comment). */
  .badge.legal-review-needed { background: #dbeafe; color: #1e40af; border: 1px solid #bfdbfe; }
  .badge.mason-finding-confirmed { background: #e6f4ea; color: var(--green); border: 1px solid #b7e1c3; }
  .badge.mason-finding-needs-source-check { background: #fef7e0; color: var(--yellow); border: 1px solid #f5e1a8; }
  .badge.mason-finding-flag-for-attorney { background: #fef3e6; color: #b45309; border: 1px solid #f5d9a8; }
  .badge.mason-finding-reject { background: #fce8e6; color: var(--red); border: 1px solid #f5c2be; }
  .filters { margin-bottom: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .filters a {
    padding: 6px 12px;
    border-radius: 999px;
    background: #fff;
    border: 1px solid var(--border);
    text-decoration: none;
    color: #333;
    font-size: 0.85rem;
  }
  .filters a.active { background: var(--blue); color: #fff; border-color: var(--blue); }
  .item-title { font-size: 1.05rem; font-weight: 600; margin-bottom: 4px; }
  .item-title a { color: #1b1f23; text-decoration: none; }
  .item-title a:hover { text-decoration: underline; }
  .item-meta { font-size: 0.85rem; color: #666; margin-top: 6px; }
  .draft-body {
    white-space: pre-wrap;
    font-size: 0.98rem;
    background: #fafbfc;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    max-height: 60vh;
    overflow-y: auto;
  }
  .draft-body blockquote.ai-quote {
    margin: 10px 0 4px 0;
    padding: 8px 14px;
    border-left: 4px solid #4338ca;
    background: #eef0ff;
    font-style: italic;
    color: #2b2f77;
    white-space: normal;
  }
  .draft-body blockquote.ai-quote footer {
    margin-top: 6px;
    font-style: normal;
    font-size: 0.85rem;
    color: #4338ca;
  }
  .draft-body blockquote.ai-quote footer a { color: #4338ca; }
  mark.review-flag {
    background: #fde68a;
    color: #7c4a00;
    padding: 1px 3px;
    border-radius: 3px;
    font-weight: 600;
  }
  /* Distinct blue treatment for "[LEGAL CLAIM PENDING REVIEW: ...]" — a
     sourced-but-unreviewed legal claim, different from the amber
     "[NEEDS HUMAN REVIEW: ...]" flag above (uncertain/unsourced). */
  mark.legal-claim-flag {
    background: #bfdbfe;
    color: #1e3a8a;
    padding: 1px 3px;
    border-radius: 3px;
    font-weight: 600;
  }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
  button, .btn {
    font-size: 0.95rem;
    padding: 10px 18px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-weight: 600;
    text-decoration: none;
    display: inline-block;
  }
  .btn-approve { background: var(--green); color: #fff; }
  .btn-reject { background: var(--red); color: #fff; }
  .btn-changes { background: var(--yellow); color: #fff; }
  .btn-secondary { background: #fff; color: #333; border: 1px solid var(--border); }
  .btn-approve:hover, .btn-reject:hover, .btn-changes:hover { opacity: 0.9; }
  form.inline-form { margin-top: 10px; }
  textarea, input[type=text], input[type=email], input[type=password] {
    width: 100%;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    font-size: 0.95rem;
    font-family: inherit;
  }
  textarea { min-height: 80px; }
  label { font-weight: 600; font-size: 0.9rem; display: block; margin-bottom: 4px; margin-top: 10px; }
  select { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 0.95rem; font-family: inherit; background: #fff; }
  .checkbox-group { border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; max-height: 260px; overflow-y: auto; }
  .checkbox-group label { font-weight: 400; display: flex; align-items: center; gap: 8px; margin: 8px 0; }
  .checkbox-group input[type=checkbox] { width: auto; }
  .helper-text { font-size: 0.85rem; color: #666; margin-top: 4px; }
  .generating-wrap { max-width: 480px; margin: 80px auto; text-align: center; }
  .spinner { width: 40px; height: 40px; border: 4px solid var(--border); border-top-color: var(--blue); border-radius: 50%; margin: 0 auto 20px; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  details.claim { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; }
  details.claim summary { cursor: pointer; font-weight: 600; }
  details.claim .claim-body { margin-top: 8px; font-size: 0.9rem; color: #444; }
  .claim-confidence { font-size: 0.75rem; padding: 2px 7px; border-radius: 999px; margin-left: 6px; }
  .claim-confidence.HIGH { background: #e6f4ea; color: var(--green); }
  .claim-confidence.MEDIUM { background: #fef7e0; color: var(--yellow); }
  .claim-confidence.LOW { background: #fce8e6; color: var(--red); }
  .card.legal-review-alert { background: #fff9f8; border: 1px solid #f5c2be; }
  .legal-claim-card.unresolved { border-left: 4px solid var(--red); }
  .legal-claim-card.resolved { border-left: 4px solid var(--green); }
  .section-edit-block { border: 1px dashed var(--border); border-radius: 8px; padding: 12px; margin-bottom: 10px; }
  .section-edit-block h4 { margin: 0 0 6px 0; font-size: 0.9rem; }
  .edit-history-entry { margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  .edit-history-entry:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
  .diff-block { margin-top: 8px; max-height: 40vh; }
  .diff-removed { background: #fce8e6; color: var(--red); text-decoration: line-through; padding: 1px 2px; border-radius: 3px; }
  .diff-added { background: #e6f4ea; color: var(--green); text-decoration: underline; padding: 1px 2px; border-radius: 3px; }
  .login-wrap {
    max-width: 380px;
    margin: 60px auto;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
  }
  .login-wrap h1 { font-size: 1.3rem; text-align: center; }
  .empty-state { text-align: center; color: #777; padding: 40px 16px; }
  .caption-block { border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin-bottom: 10px; }
  .caption-platform { font-weight: 700; text-transform: capitalize; margin-bottom: 6px; }
  .safety-note {
    font-size: 0.8rem;
    color: #888;
    margin-top: 30px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .chat-log {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 50vh;
    overflow-y: auto;
    padding: 4px 2px;
    margin-bottom: 14px;
  }
  .chat-turn { max-width: 88%; padding: 10px 14px; border-radius: 14px; font-size: 0.95rem; }
  .chat-turn .chat-meta { display: block; font-size: 0.72rem; font-weight: 600; opacity: 0.7; margin-bottom: 4px; }
  .chat-turn .chat-text { white-space: pre-wrap; word-break: break-word; }
  .chat-turn.peter { align-self: flex-end; background: var(--blue); color: #fff; border-bottom-right-radius: 3px; }
  .chat-turn.ai { align-self: flex-start; background: var(--gray-bg); border: 1px solid var(--border); color: #1b1f23; border-bottom-left-radius: 3px; }
  .chat-turn .chat-badge { display: inline-block; margin-top: 6px; }
  .chat-turn a.chat-edit-link { display: inline-block; margin-top: 6px; font-size: 0.82rem; font-weight: 600; }
  .chat-turn.peter a.chat-edit-link { color: #dbe6ff; }
  .chat-turn.ai a.chat-edit-link { color: var(--blue); }
  .chat-thinking { display: flex; align-items: center; gap: 10px; padding: 8px 2px 14px; color: #555; font-size: 0.9rem; }
  .chat-spinner { width: 18px; height: 18px; border-width: 3px; margin: 0; }
  #chat-message { min-height: 70px; }
  @media (max-width: 480px) {
    .chat-turn { max-width: 96%; }
  }
  @media (max-width: 480px) {
    .actions { flex-direction: column; }
    .actions button, .actions .btn { width: 100%; }
  }

  /* Draft/Review tab bar — same visual pattern as Call Stats' Stats/Users
     tabs (projects/hub/call-stats/dashboard/index.html: .tab-bar/.tab-btn),
     reused here as plain navigation links between the two top-level pages
     (/content-engine and /content-review) rather than client-side tabs. */
  .tab-bar { display: flex; gap: 2px; border-bottom: 2px solid var(--border); margin-bottom: 18px; }
  .tab-btn { background: none; border: none; border-bottom: 2px solid transparent; margin-bottom: -2px; padding: 9px 16px; font-size: 13px; font-weight: 500; color: #6b7280; cursor: pointer; text-decoration: none; display: inline-block; }
  .tab-btn:hover { color: #374151; }
  .tab-btn.tab-active { color: var(--blue); border-bottom-color: var(--blue); }
</style>
</head>
<body>
${GLOBAL_SEARCH_WIDGET_HTML}
${user ? `<header class="topbar">
  <div class="brand"><a class="back-to-hub" href="/">&larr; Rincon Hub</a>Rincon Content Review</div>
  <nav>
    <a href="/content-review">Drafts</a>
    <a href="/content-review/topics">Topic Suggestions</a>
    <a href="/content-review/legal-updates">Legal Updates</a>
    <a href="/content-review/ideas/new">Submit an Idea</a>
    <a href="/content-review/social/new">New Social Post</a>
    <a href="/content-review/social/batches">Social Batches</a>
    <a href="/content-review/brand-guide">Brand Guide</a>
  </nav>
  <div class="user-info">${escapeHtml(user.email)} &nbsp;·&nbsp; <a href="/logout">Log out</a></div>
</header>` : ''}
<main>
${user ? `<div class="tab-bar">
  <a class="tab-btn" href="/content-engine">Draft</a>
  <a class="tab-btn tab-active" href="/content-review">Review</a>
</div>` : ''}
${flash ? `<div class="flash ${flash.type}">${escapeHtml(flash.message)}</div>` : ''}
${body}
</main>
</body>
</html>`;
}

module.exports = { layout, escapeHtml };
