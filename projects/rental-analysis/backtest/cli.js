/**
 * backtest/cli.js
 * Command-line parsing for run.js. Strict on purpose: an option the program
 * does not know (a typo such as --limt) is an error, not something silently
 * ignored, because ignoring it would run a different test than the one asked
 * for. Both "--name value" and "--name=value" are accepted for options that take
 * a value. Parsing happens before anything heavy is loaded or any data is read.
 */

const VALUE_OPTIONS = {
  limit: { what: 'a whole number', test: v => /^[1-9]\d*$/.test(v) },
  'target-from': { what: 'a date as YYYY-MM-DD', test: isDate },
  'holdout-from': { what: 'a date as YYYY-MM-DD', test: isDate },
  today: { what: 'a date as YYYY-MM-DD', test: isDate },
  'data-from': { what: 'a date as YYYY-MM-DD', test: isDate },
  out: { what: 'a folder path', test: v => v.length > 0 },
};
const FLAG_OPTIONS = ['help', 'refresh', 'fidelity', 'no-leak-test', 'no-asof-listing', 'asof-listing', 'judge-holdout', 'rejudge', 'plant-leak', 'publish', 'a0'];

function isDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());
}

function validOptionsText() {
  return [...FLAG_OPTIONS, ...Object.keys(VALUE_OPTIONS)].sort().map(o => `--${o}`).join(', ');
}

class CliError extends Error {}

/**
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{flags: Set<string>, values: Object<string,string>}}
 * @throws {CliError} a one-line message
 */
function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new CliError(`Unexpected argument "${token}". Options start with --. Valid options: ${validOptionsText()}`);
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const inline = eq === -1 ? null : token.slice(eq + 1);
    if (VALUE_OPTIONS[name]) {
      const spec = VALUE_OPTIONS[name];
      let value = inline;
      if (value === null) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) throw new CliError(`Option --${name} needs ${spec.what}, for example --${name} VALUE or --${name}=VALUE.`);
        value = next;
        i++;
      }
      if (!spec.test(value)) throw new CliError(`Option --${name} needs ${spec.what}, not "${value}".`);
      values[name] = value;
    } else if (FLAG_OPTIONS.includes(name)) {
      if (inline !== null) throw new CliError(`Option --${name} does not take a value.`);
      flags.add(name);
    } else {
      throw new CliError(`Unknown option "--${name}". Valid options: ${validOptionsText()}`);
    }
  }
  return { flags, values };
}

module.exports = { parseArgs, CliError, validOptionsText, VALUE_OPTIONS, FLAG_OPTIONS };
