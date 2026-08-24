/**
 * lib/global-search-widget.js
 * The hub-wide "search properties" box — one small, self-contained block
 * of HTML + inline CSS + inline JS, dropped onto every logged-in page
 * (server.js's page() helper for the home page; each tool's dashboard
 * HTML for the rest — see insurance/router.js, security-deposit/router.js,
 * and maintenance-history/router.js, which each inject this same string
 * right after <body> before sending their dashboard file).
 *
 * Exported as a single HTML string rather than a real shared UI component
 * because nothing in this codebase has a templating/component system —
 * every page here is a plain string template (see server.js's page()) or
 * a static HTML file. A plain string that gets the exact same markup
 * dropped into four places keeps this consistent without inventing new
 * infrastructure just for one small widget.
 *
 * Talks to GET /api/hub/search-properties (lib/property-search.js) — see
 * that file for what a match looks like: { id, name, address, city,
 * tools: { insurance, maintenance_history, security_deposit } }. Only
 * tools with tools.<x> === true get a link; a property matched by name
 * but with no data anywhere yet shows a plain "No records yet" line.
 *
 * Styled to match server.js's page() helper (stone/neutral palette:
 * #1c1917 text, #78716c muted, #d6d3d1 borders, #f5f5f4 backgrounds) —
 * deliberately NOT each dashboard's own color scheme, per the build
 * task's instruction to match the hub's shell styling, not invent a new
 * look. It reads as a consistent hub-level toolbar sitting above
 * whatever page-specific styling is underneath it.
 */

const GLOBAL_SEARCH_WIDGET_HTML = `
<div id="hub-global-search-bar" style="background:#fff;border-bottom:1px solid #e7e5e4;padding:10px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;position:relative;">
    <input type="text" id="hubGlobalSearchInput" autocomplete="off"
      placeholder="Search properties (any tool)&hellip;"
      style="width:100%;padding:0.45rem 0.7rem;box-sizing:border-box;border:1px solid #d6d3d1;border-radius:4px;font-size:0.875rem;color:#1c1917;font-family:inherit;">
    <div id="hubGlobalSearchResults" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid #d6d3d1;border-top:none;border-radius:0 0 4px 4px;max-height:340px;overflow-y:auto;box-shadow:0 4px 10px rgba(0,0,0,0.08);z-index:1000;"></div>
  </div>
</div>
<script>
(function () {
  var input = document.getElementById('hubGlobalSearchInput');
  var results = document.getElementById('hubGlobalSearchResults');
  if (!input || !results) return;

  var debounceTimer = null;
  var currentQuery = '';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toolLink(base, prop) {
    var label = prop.name || prop.address || '';
    return base + '?property=' + encodeURIComponent(label);
  }

  function renderResults(matches, query) {
    if (!matches.length) {
      results.innerHTML = '<div style="padding:0.6rem 0.75rem;color:#78716c;font-size:0.8125rem;">No properties match &ldquo;' + escapeHtml(query) + '&rdquo;</div>';
      results.style.display = 'block';
      return;
    }
    results.innerHTML = matches.map(function (p) {
      var links = [];
      if (p.tools && p.tools.insurance) {
        links.push('<a href="' + toolLink('/insurance', p) + '" style="margin-right:0.75rem;color:#44403c;">Insurance</a>');
      }
      if (p.tools && p.tools.maintenance_history) {
        links.push('<a href="' + toolLink('/maintenance-history', p) + '" style="margin-right:0.75rem;color:#44403c;">Maintenance History</a>');
      }
      if (p.tools && p.tools.security_deposit) {
        links.push('<a href="' + toolLink('/security-deposit', p) + '" style="margin-right:0.75rem;color:#44403c;">Security Deposit</a>');
      }
      var linkRow = links.length
        ? '<div style="margin-top:3px;font-size:0.75rem;">' + links.join('') + '</div>'
        : '<div style="margin-top:3px;font-size:0.75rem;color:#a8a29e;">No records yet in any tool</div>';
      return '<div style="padding:0.55rem 0.75rem;border-bottom:1px solid #f5f5f4;">' +
        '<div style="font-size:0.875rem;font-weight:600;color:#1c1917;">' + escapeHtml(p.name || p.address || 'Unknown property') + '</div>' +
        (p.address ? '<div style="font-size:0.75rem;color:#78716c;">' + escapeHtml(p.address) + (p.city ? ', ' + escapeHtml(p.city) : '') + '</div>' : '') +
        linkRow +
        '</div>';
    }).join('');
    results.style.display = 'block';
  }

  input.addEventListener('input', function () {
    var q = input.value.trim();
    currentQuery = q;
    clearTimeout(debounceTimer);
    if (!q) {
      results.style.display = 'none';
      results.innerHTML = '';
      return;
    }
    debounceTimer = setTimeout(function () {
      fetch('/api/hub/search-properties?q=' + encodeURIComponent(q), { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (matches) {
          if (q !== currentQuery) return; // a newer keystroke already fired — drop this stale response
          renderResults(matches || [], q);
        })
        .catch(function () { /* search is a convenience, not core — fail quietly */ });
    }, 200);
  });

  input.addEventListener('focus', function () {
    if (input.value.trim() && results.innerHTML) results.style.display = 'block';
  });

  document.addEventListener('click', function (e) {
    var bar = document.getElementById('hub-global-search-bar');
    if (bar && !bar.contains(e.target)) {
      results.style.display = 'none';
    }
  });
})();
</script>
`;

module.exports = { GLOBAL_SEARCH_WIDGET_HTML };
