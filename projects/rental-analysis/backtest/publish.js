/**
 * backtest/publish.js
 * --publish: copy THIS run's scorecard into lib/accuracy-scorecard.json in both
 * lib folders. It publishes the scorecard this run just built, never a file
 * left over from an earlier run, and only when that scorecard is trusted (leak
 * self-test passed, fidelity check valid for today's code and data) and the
 * run was complete. Anything else is a refusal with a clear reason; the caller
 * turns a refusal into a non-zero exit code.
 */
const fs = require('fs');
const path = require('path');

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * @param {{scorecard: object, partial: boolean, targets: string[]}} args - targets are the files to write (a test passes temp files)
 * @returns {{ok: boolean, message: string}}
 */
function publishScorecard({ scorecard, partial, targets }) {
  if (partial) {
    return { ok: false, message: 'Refusing to --publish: this was a partial run (limited targets or a debug flag), and only a complete run may be published.' };
  }
  if (!scorecard || !scorecard.trusted) {
    const why = scorecard && scorecard.trustReasons && scorecard.trustReasons.length ? scorecard.trustReasons.join('; ') : 'no scorecard was built';
    return { ok: false, message: `Refusing to --publish: this run's scorecard is not trusted (${why}).` };
  }
  for (const p of targets) writeJson(p, scorecard);
  return { ok: true, message: `Published this run's scorecard to ${targets.length} file(s) (lib/accuracy-scorecard.json in both lib folders). Review and commit it yourself.` };
}

module.exports = { publishScorecard };
