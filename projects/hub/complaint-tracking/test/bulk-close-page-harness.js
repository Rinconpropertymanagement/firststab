'use strict';

/**
 * test/bulk-close-page-harness.js
 * Runs the dashboard's own "Close old items" panel code (lifted out of
 * dashboard/index.html, the same sandbox technique as the lane-rule test) inside
 * a tiny stand-in for the browser, so the test suite can feed it the REAL answers
 * of the real server code and read what the person would see.
 *
 *  - Nothing here knows what the page says or which fields it reads. It lifts the
 *    page's whole panel script (from `var CO_BASE =` up to `init();`, wiring and
 *    keyboard handling included), runs it, and offers: open the panel, press a
 *    button by its data-co / data-batch attributes, type into the settings, and
 *    read the screen as text.
 *  - The stand-in DOM understands just enough HTML: every element with an id gets
 *    its own object whose innerHTML can be set, and the screen is the root's
 *    HTML with each of those objects' current content put back in place. It does
 *    not run layout, styles or focus rules.
 *  - A button that is marked disabled does nothing when pressed, as in a browser.
 *  - fetch() is whatever the test supplies (the real routes over the fake
 *    database); nothing leaves the process.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PAGE_PATH = path.join(__dirname, '..', 'dashboard', 'index.html');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} was not found in dashboard/index.html`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`function ${name} in dashboard/index.html never closes`);
}

// The panel's script: everything from its first variable to the page's own start-up call.
function panelSource(html) {
  const start = html.indexOf('var CO_BASE =');
  const end = html.lastIndexOf('init();');
  if (start === -1) throw new Error('the Close old items panel (var CO_BASE) was not found in dashboard/index.html');
  if (end === -1 || end < start) throw new Error('the end of the Close old items panel (init();) was not found in dashboard/index.html');
  return html.slice(start, end);
}

// ─── A very small DOM ────────────────────────────────────────────────────

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);

// The top-level elements in `html` that carry an id: where their content starts and ends.
function scanIdElements(html) {
  const found = [];
  const openRe = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let skipUntil = -1;
  let m;
  while ((m = openRe.exec(html)) !== null) {
    if (m.index < skipUntil) continue;
    const idMatch = /\sid="([^"]+)"/.exec(m[2]);
    if (!idMatch) continue;
    const tag = m[1].toLowerCase();
    const openEnd = m.index + m[0].length;
    if (VOID_TAGS.has(tag) || /\/\s*$/.test(m[2])) {
      found.push({ id: idMatch[1], openEnd, closeStart: openEnd });
      skipUntil = openEnd;
      continue;
    }
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = openEnd;
    let depth = 1;
    let c = null;
    while (depth > 0 && (c = re.exec(html)) !== null) depth += c[1] ? -1 : 1;
    if (depth !== 0 || !c) throw new Error(`the page produced HTML where <${tag} id="${idMatch[1]}"> never closes`);
    found.push({ id: idMatch[1], openEnd, closeStart: c.index });
    skipUntil = c.index + c[0].length;
  }
  return found;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', middot: '·', times: '×', mdash: '—', ndash: '–' };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : all;
  });
}

function htmlToText(html) {
  const spaced = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th|section|ul|table|caption|button|label|form)>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(spaced).replace(/\s+/g, ' ').trim();
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g;
  let m;
  while ((m = re.exec(text)) !== null) attrs[m[1]] = m[2] === undefined ? '' : decodeEntities(m[2]);
  return attrs;
}

function makeDom() {
  const byId = new Map();
  const listeners = { overlay: {}, document: {} };

  class El {
    constructor(id, html) {
      this.id = id;
      this._html = '';
      this._kids = [];
      this._attrs = {};
      this.disabled = false;
      this.hidden = false;
      this.style = {};
      this.scrollTop = 0;
      this.textContent = '';
      this.innerHTML = html || '';
    }

    get innerHTML() { return this._html; }

    set innerHTML(value) {
      for (const kid of this._kids) forget(kid.el);
      this._html = String(value);
      this._kids = scanIdElements(this._html).map((span) => {
        const el = new El(span.id, this._html.slice(span.openEnd, span.closeStart));
        byId.set(span.id, el);
        return { span, el };
      });
    }

    // This element's HTML with the current content of every element inside it put back in place.
    currentHtml() {
      let out = '';
      let pos = 0;
      for (const { span, el } of this._kids) {
        out += this._html.slice(pos, span.openEnd) + el.currentHtml();
        pos = span.closeStart;
      }
      return out + this._html.slice(pos);
    }

    setAttribute(name, value) { this._attrs[name] = String(value); }
    removeAttribute(name) { delete this._attrs[name]; }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }
    focus() { dom.focused = this.id; }
    contains() { return false; }
    querySelectorAll() { return []; }
    scrollIntoView() {}
    addEventListener(type, fn) { (listeners.overlay[type] = listeners.overlay[type] || []).push(fn); }
  }

  function forget(el) {
    if (byId.get(el.id) === el) byId.delete(el.id);
    for (const kid of el._kids) forget(kid.el);
  }

  const dom = { focused: null, byId };
  const overlay = new El('closeOldOverlay', '');
  byId.set('closeOldOverlay', overlay);
  const pageEl = new El('page', '');
  dom.overlay = overlay;

  dom.document = {
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => (sel === '.page' ? pageEl : null),
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (listeners.document[type] = listeners.document[type] || []).push(fn); },
    body: { style: {}, contains: () => false },
    documentElement: { scrollTop: 0 },
    activeElement: null,
  };
  dom.window = { pageYOffset: 0, scrollTo: () => {} };
  dom.screenHtml = () => overlay.currentHtml();
  dom.screenText = () => htmlToText(overlay.currentHtml());
  dom.listeners = listeners;
  dom.hidden = () => overlay.hidden;
  return dom;
}

// Every <button> on the screen: its attributes, its words, and whether it is disabled.
function buttonsIn(html) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = parseAttrs(m[1]);
    const disabled = Object.prototype.hasOwnProperty.call(attrs, 'disabled');
    out.push({ attrs, disabled, label: htmlToText(m[2]), ariaLabel: attrs['aria-label'] || '', html: m[0] });
  }
  return out;
}

// ─── The panel ───────────────────────────────────────────────────────────

/**
 * fetchImpl(url, opts) -> Promise of { ok, status, text() } (what the routes answer).
 * Returns the panel: open(), settle(), press(), type, tick, and what is on the screen.
 */
function loadPanel({ fetchImpl, html = fs.readFileSync(PAGE_PATH, 'utf8') }) {
  const dom = makeDom();
  const record = { fetches: [], listRefreshes: 0, toasts: [] };
  let pending = 0;

  const sandbox = {
    document: dom.document,
    window: dom.window,
    console,
    writesInFlight: 0,
    fetch: (url, opts) => {
      record.fetches.push({ url: String(url), method: ((opts && opts.method) || 'GET').toUpperCase(), body: opts && opts.body ? JSON.parse(opts.body) : null });
      pending += 1;
      return Promise.resolve(fetchImpl(url, opts)).then(
        (res) => { pending -= 1; return res; },
        (err) => { pending -= 1; throw err; },
      );
    },
    fetchComplaintList: () => { record.listRefreshes += 1; return Promise.resolve([]); },
    applyComplaintList: () => {},
    render: () => {},
    showToast: (...args) => { record.toasts.push(args); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${extractFunction(html, 'escapeHtml')}\n${panelSource(html)}`, sandbox, { filename: 'dashboard/index.html (Close old items panel)' });

  const run = (code) => vm.runInContext(code, sandbox);

  const panel = {
    dom,
    record,
    run,
    state: () => run('typeof coState === "undefined" ? null : coState'),
    isOpen: () => !!panel.state(),

    // Lets every request in flight, and everything it sets off, finish.
    async settle() {
      for (let quiet = 0; quiet < 3;) {
        await new Promise((resolve) => setImmediate(resolve));
        if (pending === 0) quiet += 1; else quiet = 0;
      }
    },

    async open() {
      run('coOpen(null)');
      await panel.settle();
    },

    screenText: () => dom.screenText(),
    screenHtml: () => dom.screenHtml(),
    buttons: () => buttonsIn(dom.screenHtml()),
    button(match) {
      return panel.buttons().find((b) => Object.entries(match).every(([k, v]) => b.attrs[k] === v)) || null;
    },
    undoButton(batchId) { return panel.button({ 'data-co': 'undo', 'data-batch': batchId }); },

    // Presses a button the way a click does: nothing happens if it is disabled or not there.
    async press(match) {
      const b = panel.button(match);
      if (!b) throw new Error(`no button ${JSON.stringify(match)} on the screen. Buttons: ${panel.buttons().map((x) => x.label).join(' | ')}`);
      if (b.disabled) return false;
      const target = {
        disabled: false,
        closest: (sel) => (sel === '[data-co]' && b.attrs['data-co'] !== undefined ? target : null),
        getAttribute: (name) => (Object.prototype.hasOwnProperty.call(b.attrs, name) ? b.attrs[name] : null),
      };
      for (const fn of dom.listeners.overlay.click || []) fn({ target });
      await panel.settle();
      return true;
    },

    // Settings fields, through the page's own change / input handlers.
    async setDays(value) {
      for (const fn of dom.listeners.overlay.input || []) fn({ target: { id: 'coDays', value: String(value) } });
    },
    async tick(id, checked) {
      for (const fn of dom.listeners.overlay.change || []) fn({ target: { id, checked: !!checked } });
    },
    async submitPreview() {
      for (const fn of dom.listeners.overlay.submit || []) fn({ target: { id: 'coForm' }, preventDefault() {} });
      await panel.settle();
    },
    async preview() { await panel.submitPreview(); },
    async dismiss() {
      for (const fn of dom.listeners.overlay.click || []) {
        const target = { disabled: false, closest: (sel) => (sel === '[data-co]' ? target : null), getAttribute: (n) => (n === 'data-co' ? 'dismiss' : null) };
        fn({ target });
      }
      await panel.settle();
    },
    closedForGood: () => panel.state() === null,
  };
  return panel;
}

// ─── The real routes, as the page's fetch() ───────────────────────────────

/**
 * Wraps a routes table captured from mountBulkCloseRoutes (handlers[`GET /path`]
 * = [requireAccess, ..., handler]) so the page can call it like fetch(): same
 * status codes, the body goes through JSON on the way (so it is exactly what the
 * browser would parse).
 */
function routeFetch(handlers, { email = 'peter@rincon.test', name = 'Peter McKenzie' } = {}) {
  const BASE = '/api/complaint-tracking/bulk-close';
  return async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(String(url), 'http://hub.test');
    let key = `${method} ${u.pathname}`;
    let params = {};
    const undo = new RegExp(`^${BASE}/([^/]+)/undo$`).exec(u.pathname);
    if (undo) { key = `${method} ${BASE}/:batch_id/undo`; params = { batch_id: decodeURIComponent(undo[1]) }; }
    const chain = handlers[key];
    const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
    if (!chain) return reply(404, { error: 'No such route.' });
    const req = {
      method, query: Object.fromEntries(u.searchParams), params, body: opts.body ? JSON.parse(opts.body) : undefined,
      headers: {}, get: () => undefined, user: { id: 'user-1', email }, complaintTrackingRole: 'admin', complaintTrackingMemberName: name,
    };
    const out = { status: 200, body: null };
    const res = { status(code) { out.status = code; return res; }, json(body) { out.body = body; return res; } };
    for (const fn of chain) {
      let advanced = false;
      await fn(req, res, () => { advanced = true; });
      if (!advanced) break;
    }
    return reply(out.status, out.body);
  };
}

module.exports = { loadPanel, routeFetch, htmlToText, buttonsIn, panelSource, PAGE_PATH };
