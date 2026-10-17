/**
 * backtest/netguard.js
 * Measures, instead of asserting, what the accuracy test sends over the network.
 *
 * Installed once at the top of a run, it wraps global fetch and http(s).request /
 * http(s).get, classifies every outbound attempt by host, and counts it under
 * the current phase:
 *   refresh   pulling fresh data (Recore + Supabase reads)
 *   fidelity  the live check against Recore
 *   replay    everything else: the replay and all the scoring, which must make
 *             NO outbound request at all
 * Hosts allowed through: Recore and the project's own Supabase host. RentCast,
 * Anthropic and any other host are BLOCKED: the attempt is counted, the request
 * is not made, and an error is thrown that stops the run. The counts go into
 * the scorecard so "RentCast requests: 0" is a measured number.
 */
const http = require('http');
const https = require('https');

function classify(host, supabaseHost) {
  const h = String(host || '').toLowerCase();
  if (/(^|\.)rentcast\.io$/.test(h)) return 'rentcast';
  if (/(^|\.)anthropic\.com$/.test(h)) return 'anthropic';
  if (/(^|\.)recore\.net$/.test(h)) return 'recore';
  if (supabaseHost && h === supabaseHost.toLowerCase()) return 'supabase';
  return 'other';
}

function hostFromFetchInput(input) {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input && typeof input.url === 'string') return new URL(input.url).hostname; // a Request
    if (input && typeof input.href === 'string') return new URL(input.href).hostname; // a URL
  } catch (_) { /* fall through */ }
  return '';
}

function hostFromRequestArgs(args) {
  const [a, b] = args;
  try {
    if (typeof a === 'string') return new URL(a).hostname;
    if (a instanceof URL) return a.hostname;
    const o = a && typeof a === 'object' ? a : (b && typeof b === 'object' ? b : {});
    return o.hostname || (o.host ? String(o.host).split(':')[0] : '');
  } catch (_) { return ''; }
}

/**
 * @param {object} [opts]
 * @param {object} [opts.target] - object holding fetch (default globalThis); tests pass their own
 * @param {{http: object, https: object}} [opts.modules] - the http(s) modules to wrap
 * @param {string} [opts.supabaseUrl] - the project's Supabase URL (default from the environment)
 */
function installNetGuard({ target = globalThis, modules = { http, https }, supabaseUrl = process.env.SUPABASE_URL } = {}) {
  let supabaseHost = '';
  try { supabaseHost = supabaseUrl ? new URL(supabaseUrl).hostname : ''; } catch (_) { /* none */ }
  const state = { phase: 'replay', byPhase: {}, total: { recore: 0, supabase: 0, rentcast: 0, anthropic: 0, other: 0 }, blockedHosts: new Set() };
  const bump = cls => {
    state.total[cls]++;
    state.byPhase[state.phase] = state.byPhase[state.phase] || { recore: 0, supabase: 0, rentcast: 0, anthropic: 0, other: 0 };
    state.byPhase[state.phase][cls]++;
  };
  const check = host => {
    const cls = classify(host, supabaseHost);
    bump(cls);
    if (cls === 'recore' || cls === 'supabase') return;
    state.blockedHosts.add(cls === 'other' ? 'other-host' : cls);
    throw new Error(`Blocked outbound request to ${cls === 'other' ? 'an unexpected host' : cls} (${host || 'unknown host'}): the accuracy test never calls it.`);
  };

  const originalFetch = target.fetch;
  if (typeof originalFetch === 'function') {
    target.fetch = async function guardedFetch(input, init) {
      check(hostFromFetchInput(input));
      return originalFetch.call(this, input, init);
    };
  }
  const originals = [];
  for (const mod of Object.values(modules)) {
    for (const fn of ['request', 'get']) {
      if (typeof mod[fn] !== 'function') continue;
      const orig = mod[fn];
      originals.push([mod, fn, orig]);
      mod[fn] = function guardedRequest(...args) { check(hostFromRequestArgs(args)); return orig.apply(this, args); };
    }
  }

  return {
    setPhase(phase) { state.phase = phase; },
    get phase() { return state.phase; },
    counts() {
      const replay = state.byPhase.replay || { recore: 0, supabase: 0, rentcast: 0, anthropic: 0, other: 0 };
      return {
        measured: true,
        rentcastRequests: state.total.rentcast,
        anthropicRequests: state.total.anthropic,
        otherHostRequests: state.total.other,
        requestsDuringReplay: Object.values(replay).reduce((a, b) => a + b, 0),
        recoreRequests: state.total.recore,
        supabaseRequests: state.total.supabase,
      };
    },
    uninstall() {
      if (typeof originalFetch === 'function') target.fetch = originalFetch;
      for (const [mod, fn, orig] of originals) mod[fn] = orig;
    },
  };
}

module.exports = { installNetGuard, classify, hostFromFetchInput, hostFromRequestArgs };
