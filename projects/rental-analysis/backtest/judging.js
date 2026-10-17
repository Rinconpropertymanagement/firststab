/**
 * backtest/judging.js
 * "Judged once" (CMA-QUALITY-SPEC.md A.5): a tuning candidate is chosen on the
 * tune period and judged on the hold-out. To keep that honest the lock is keyed
 * on the candidate and on the END date of the last hold-out it was judged on.
 * A candidate may be judged again only on a hold-out that STARTS AFTER that end
 * date, so a rejected candidate cannot be re-judged on a hold-out that overlaps
 * one it already saw, however the monthly window slides.
 *
 * Every judgement stores its full verdict text. Asking again on an overlapping
 * hold-out does not recompute anything: it hands back the stored verdict, so a
 * repeat run prints the same answer and never leaves an empty verdict section
 * in the report.
 */

function verdictText(label, verdict) {
  return `${label}: ${verdict.pass ? 'PASSES' : 'does not pass'} (${verdict.checks.map(c => `${c.id}: ${c.pass ? 'ok' : 'FAIL'} ${c.detail}`).join('; ')})`;
}

/**
 * @returns {{ok: boolean, override?: boolean, reason?: string}}
 */
function canJudge(entry, holdoutStart, rejudge = false) {
  if (!entry) return { ok: true };
  if (rejudge) return { ok: true, override: true };
  if (typeof entry === 'string' || !entry.holdoutEnd) {
    return { ok: false, reason: 'an older lock entry without a stored verdict exists; judging it again needs --rejudge' };
  }
  if (holdoutStart > entry.holdoutEnd) return { ok: true };
  return { ok: false, reason: `already judged on ${entry.judgedOn} on the hold-out ${entry.holdoutStart} to ${entry.holdoutEnd}; it can be judged again only on a hold-out that starts after ${entry.holdoutEnd}` };
}

/**
 * @param {object} args
 * @param {object} args.store - the parsed holdout-judged.json ({} when none)
 * @param {{key: string, label: string, evaluate: Function}[]} args.items - evaluate() returns an acceptance verdict and is only called when judging is allowed
 * @param {string} args.holdoutStart
 * @param {string} args.holdoutEnd - the newest lease date in this hold-out
 * @param {string} args.today
 * @param {boolean} [args.rejudge]
 * @returns {{verdicts: object[], store: object}} verdicts always has one entry per item: new, or the stored one
 */
function judgeCandidates({ store, items, holdoutStart, holdoutEnd, today, rejudge = false }) {
  const next = { ...store };
  const verdicts = [];
  for (const item of items) {
    const entry = store[item.key];
    const decision = canJudge(entry, holdoutStart, rejudge);
    if (!decision.ok) {
      const judgedOn = typeof entry === 'string' ? entry : entry.judgedOn;
      verdicts.push({
        label: item.label, stored: true,
        text: (entry && entry.text) || `${item.label}: judged${judgedOn ? ` on ${judgedOn}` : ' earlier'} (verdict text was not saved)`,
        judgedOn, holdoutStart: entry && entry.holdoutStart, holdoutEnd: entry && entry.holdoutEnd, note: decision.reason,
      });
      continue;
    }
    const verdict = item.evaluate();
    const text = verdictText(item.label, verdict);
    const record = { label: item.label, judgedOn: today, holdoutStart, holdoutEnd, verdict, text };
    if (typeof entry === 'string') record.previous = [{ judgedOn: entry }]; // an old bare-date lock: keep the earlier judgement
    else if (entry && typeof entry === 'object') record.previous = [...(entry.previous || []), { judgedOn: entry.judgedOn, holdoutStart: entry.holdoutStart, holdoutEnd: entry.holdoutEnd, text: entry.text }];
    next[item.key] = record;
    verdicts.push({ label: item.label, stored: false, text, judgedOn: today, holdoutStart, holdoutEnd });
  }
  return { verdicts, store: next };
}

// One line for the report and the console. Dates that are not known (an old-format
// lock) are left out rather than printed as "undefined".
function verdictLine(v) {
  const period = v.holdoutStart && v.holdoutEnd ? ` on the hold-out ${v.holdoutStart} to ${v.holdoutEnd}` : '';
  const when = v.judgedOn ? ` ${v.judgedOn}` : '';
  return v.stored
    ? `${v.text} [stored verdict, judged${when}${period}; not judged again: ${v.note}]`
    : `${v.text} [judged${when}${period}]`;
}

module.exports = { verdictText, canJudge, judgeCandidates, verdictLine };
