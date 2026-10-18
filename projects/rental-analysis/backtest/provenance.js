/**
 * backtest/provenance.js
 * Ties the fidelity check to the exact code it was run against.
 *
 * The fidelity check proves the replay selects and maps CRMLS comps exactly as
 * the product does, but only for the code that existed when it ran. If the
 * product's comp-pulling code (or the replay itself) changes afterwards, an old
 * "pass" says nothing. So the fidelity result stores a content hash of every
 * file whose behaviour the replay depends on, and a result whose hashes do not
 * match today's files, or that has none, or that was run on an older data pull,
 * is invalid: the scorecard is then not trusted until the check is re-run
 * (node backtest/run.js --fidelity, or --refresh).
 *
 * rentcast.js is tracked even though the replay does not call it: the product
 * still runs it, and a change there is a change to what the live tool does.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// Paths are relative to projects/rental-analysis/.
const TRACKED_FILES = [
  'lib/crmls.js',
  'lib/leadsimple.js',
  'lib/sources.js',
  'lib/rentcast.js',
  'lib/weighting.js',
  'lib/property-matching.js',
  'lib/mls-facts.js',   // what facts a comp carries (furnished, lease length, 55+) and how they are cleaned
  'lib/confidence.js',  // the High / Medium / Low label worked out inside lib/analyze.js
  'lib/analyze.js',
  'lib/constants.js',
  'backtest/recore.js',     // what the pull selects (the county field is part of it)
  'backtest/asof-sources.js',
  'backtest/candidates.js', // pool settings (lookbacks, asking price rule) live here
  'backtest/engine.js',     // how one lease is run through the tool
  'backtest/selftests.js',  // the fidelity check itself
];

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * @param {string} [root] - the rental-analysis folder (a test passes a temp copy)
 * @returns {{files: Object<string,string>, combined: string}}
 */
function trackedFilesHash(root = ROOT, files = TRACKED_FILES) {
  const out = {};
  for (const f of files) {
    const p = path.join(root, f);
    out[f] = fs.existsSync(p) ? sha(fs.readFileSync(p)).slice(0, 16) : 'missing';
  }
  const combined = sha(Buffer.from(files.map(f => `${f}:${out[f]}`).join('\n'))).slice(0, 16);
  return { files: out, combined };
}

/**
 * Is a stored fidelity result still good for today's code and today's data pull?
 * @returns {{valid: boolean, reason: string|null}}
 */
function fidelityValidity(fidelity, currentHashes, cachePulledAt) {
  if (!fidelity) return { valid: false, reason: 'the fidelity check has not been run (node backtest/run.js --fidelity)' };
  if (!fidelity.pass) return { valid: false, reason: 'the fidelity check failed' };
  if (fidelity.pulledAt !== cachePulledAt) return { valid: false, reason: 'the fidelity check was run on an older data pull (re-run with --fidelity or --refresh)' };
  if (!fidelity.hashes || !fidelity.hashes.combined) return { valid: false, reason: 'the stored fidelity result does not record which code it checked (re-run with --fidelity)' };
  if (!currentHashes || fidelity.hashes.combined !== currentHashes.combined) {
    const changed = currentHashes && currentHashes.files
      ? Object.keys(currentHashes.files).filter(f => fidelity.hashes.files && fidelity.hashes.files[f] !== currentHashes.files[f])
      : [];
    return { valid: false, reason: `code changed since the fidelity check ran${changed.length ? ` (${changed.join(', ')})` : ''}; re-run with --fidelity or --refresh` };
  }
  return { valid: true, reason: null };
}

module.exports = { TRACKED_FILES, trackedFilesHash, fidelityValidity };
