#!/usr/bin/env node
/**
 * test/mutation-check.js
 *
 * Proves the tests can fail. Copies the feature and its tests into a scratch
 * folder (the real files are NEVER edited), breaks the copy one way at a time,
 * runs the relevant test file, and reports whether the suite noticed. A
 * mutant that survives (all tests still pass) is a hole in the tests.
 *
 *   node projects/hub/approval-briefing/test/mutation-check.js [--only M03,M30]
 *
 * Needs no network and no credentials. M03, M30 and M24 are the three mutants
 * Asimov's re-ruling named: job text reaching a log line in the summary-error
 * path, an error message reaching a log line in the outer catch, and job text
 * influencing the recipients.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HUB = path.resolve(__dirname, '../..');
const REPO = path.resolve(HUB, '../..');
// The slur list is only ever read from the terms file; no slur is written in this file.
const SLURS = require(path.join(HUB, 'approval-briefing/lib/work-order-text-screen-terms.js')).SLURS;

// Each mutant: which file to break, how, and which test file should notice.
const MUTANTS = [
  { id: 'M03', what: 'the summary-error path logs the job text', file: 'approval-briefing/lib/work-order-summary.js',
    from: "console.error('[work-order-summary] Unexpected error building the description block - failing closed (held).');",
    to: "console.error('[work-order-summary] Unexpected error building the description block - failing closed (held).', String(job && job.description));",
    tests: ['run-tests.js'] },
  { id: 'M03b', what: 'the summary-error path logs the error message', file: 'approval-briefing/lib/work-order-summary.js',
    from: "  } catch (_err) {\n    meta.cause = 'summary_error';\n    meta.common_word_only = false;",
    to: "  } catch (_err) {\n    console.error(String(_err && _err.message));\n    meta.cause = 'summary_error';\n    meta.common_word_only = false;",
    tests: ['run-tests.js'] },
  { id: 'M30', what: 'the outer catch prints the error message while the block is active', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "console.error(`[work-order-notes-alert] unexpected error handling job ${jobId} (${kind}); details withheld.`);",
    to: "console.error(`[work-order-notes-alert] unexpected error handling job ${jobId}: ${err.message}`);",
    tests: ['run-tests.js'] },
  { id: 'M24', what: 'the job text changes who receives the alert', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "  let email;\n  try {\n    email = buildEmailContent({ property, pod, job, notesText: notes, descriptionLines });",
    to: "  if (descriptionLines && descriptionLines.length > 2) recipients.push('extra@example.test');\n  let email;\n  try {\n    email = buildEmailContent({ property, pod, job, notesText: notes, descriptionLines });",
    tests: ['run-tests.js'] },
  { id: 'M24b', what: 'the subject changes when the block is held', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "const subject = `Work Order Alert — ${propertyLabel} has special handling notes`;",
    to: "const subject = `Work Order Alert — ${propertyLabel} has special handling notes${descriptionLines && descriptionLines.length === 2 ? ' (held)' : ''}`;",
    tests: ['run-tests.js'] },
  { id: 'M24c', what: 'the dedup lookup is given the summary', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: 'const existing = await getExistingAlertRow(latchelJobId);', to: 'const existing = await getExistingAlertRow(latchelJobId, job.description);',
    tests: ['run-tests.js'] },
  { id: 'M-AI1', what: 'the summary loads a model SDK', file: 'approval-briefing/lib/work-order-summary.js',
    from: "} = require('./work-order-text-clean');", to: "} = require('./work-order-text-clean');\nconst Sdk = require('@anthropic-ai/sdk');",
    tests: ['no-ai-proof.js'] },
  { id: 'M-AI2', what: 'the screen reads a model key from the environment', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "const SCREEN_VERSION =", to: "const MODEL_KEY = process.env.ANTHROPIC_API_KEY;\nconst SCREEN_VERSION =",
    tests: ['no-ai-proof.js'] },
  { id: 'M-AI3', what: 'the alert module loads the shared claim check', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "const crypto = require('crypto');", to: "const crypto = require('crypto');\nconst { checkClaim } = require('../../maintenance-history/lib/content-check');",
    tests: ['no-ai-proof.js'] },
  { id: 'M-NET', what: 'the summary makes a network call with the text', file: 'approval-briefing/lib/work-order-summary.js',
    from: "    // The cleaner throws (constant message) for a value that is not text.", to: "    try { await global.fetch('https://example.invalid/x', { method: 'POST', body: String(source.description) }); } catch (_e) { /* ignored */ }\n    // The cleaner throws (constant message) for a value that is not text.",
    tests: ['no-ai-proof.js'] },
  { id: 'M-SCREEN', what: 'the screen never holds anything', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: 'if (categories.size === 0) {', to: 'if (true) {', tests: ['screen-corpus.js', 'run-tests.js'] },
  { id: 'M-SHARED', what: 'the shared list is not consulted', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: '    sharedScan(shared);\n    if (words !== shared) sharedScan(words);\n', to: '', tests: ['screen-corpus.js', 'fix-round-tests.js'] },
  { id: 'M-FAILOPEN', what: 'a scanner error lets the text through', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "return { status: 'held', cause: 'check_error', categories: [], common_word_only: false, screen_version: SCREEN_VERSION };\n}\n\n/**",
    to: "return { status: 'cleared', cause: null, categories: [], common_word_only: false, screen_version: SCREEN_VERSION };\n}\n\n/**", tests: ['screen-corpus.js', 'run-tests.js'] },
  { id: 'M-SELFTEST', what: 'the start-up self-test always passes', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: 'return { ok: wrong === 0, wrong };', to: 'return { ok: true, wrong: 0 };', tests: ['screen-corpus.js'] },
  { id: 'M-STEM', what: 'stems shorter than 5 letters are allowed', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "!/^[a-z]{5,}$/.test(t)", to: "!/^[a-z]{3,}$/.test(t)", tests: ['screen-corpus.js'] },
  { id: 'M-SCRIPT', what: 'the non-Latin script rule is removed', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "if (nonLatin >= 3 || nonLatin / total > 0.10) { hit('unscreenable_language', false); return; }", to: '', tests: ['screen-corpus.js', 'run-tests.js'] },
  { id: 'M-LANG', what: 'the unrecognised-language rule is removed', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "if (words >= 8 && known / words < 0.15) hit('unscreenable_language', false);", to: '', tests: ['screen-corpus.js'] },
  { id: 'M-SSN', what: 'the SSN pattern is removed', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "if (SSN_PATTERN.test(t)) hit('financial_id', false);", to: '', tests: ['screen-corpus.js'] },
  { id: 'M-PAIR', what: 'pair rules never fire', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: 'scanPairs(tokens, hit);', to: '', tests: ['screen-corpus.js'] },
  { id: 'M-SLUR', what: 'the obfuscation fold for slurs is removed', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: ".replace(/@/g, 'a').replace(/\\$/g, 's').replace(/0/g, 'o').replace(/1/g, 'i')", to: '', tests: ['screen-corpus.js'] },
  { id: 'M-CLEAN-INVIS', what: 'variation selectors and other default-ignorable characters are no longer removed', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: 'const INVISIBLE = /[\\p{Default_Ignorable_Code_Point}\\p{Cc}', to: 'const INVISIBLE = /[\\p{Cc}', tests: ['cleaner-tests.js'] },
  { id: 'M-CLEAN-SPACE', what: 'invisible characters are replaced by a space instead of removed', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "s = s.replace(INVISIBLE, spaced ? ' ' : '');\n  // Entities first", to: "s = s.replace(INVISIBLE, ' ');\n  // Entities first", tests: ['cleaner-tests.js'] },
  { id: 'M-PROBE', what: 'the cleaner decides the spaced reading is not needed even though an invisible character or tag was removed', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "if (probe && INVISIBLE_TEST.test(s)) probe.removal = true;", to: '', tests: ['fix-round-tests.js'] },
  { id: 'M-PROBE-TAGS', what: 'the same for a removed tag', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "if (probe && ANY_TAG_TEST.test(s)) probe.removal = true;", to: '', tests: ['fix-round-tests.js'] },
  { id: 'M-CLEAN-SHORT', what: 'link shorteners are no longer neutralised', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: 'if (SHORTENERS.has(labels.join(\'.\'))) return true;', to: '', tests: ['cleaner-tests.js'] },
  { id: 'M-CLEAN-SCHEME', what: 'javascript: and data: links are no longer in the denylist', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: '|javascript|data|', to: '|', tests: ['cleaner-tests.js'] },
  { id: 'M-CLEAN-EMAIL', what: 'the domain half of a plain e-mail address gets mangled', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "  if (!hasTail && before === '@' && hasNameBeforeAt(whole, offset - 1)) return m;\n", to: '', tests: ['cleaner-tests.js'] },
  { id: 'M-CLEAN-PASSES', what: 'the cleaner stops after one pass (not idempotent, tags can survive)', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: 'const MAX_PASSES = 6;', to: 'const MAX_PASSES = 1;', tests: ['cleaner-tests.js'] },
  { id: 'M-CLEAN-STRING', what: 'a non-text value is quietly treated as empty', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "if (typeof value !== 'string') throw new CleanError('clean_not_a_string');", to: "if (typeof value !== 'string') return '';", tests: ['cleaner-tests.js', 'run-tests.js'] },
  { id: 'M-CLEAN-CAP', what: 'the output cap is removed', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: 'return capOutput(s).trim();', to: 'return s;', tests: ['cleaner-tests.js'] },
  { id: 'M-CLEAN-REDOS', what: 'the tag pattern allows ">" inside a tag (quadratic scan)', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: 'const ANY_TAG = /<\\/?[a-zA-Z][^<>]*>/g;', to: 'const ANY_TAG = /<\\/?[a-zA-Z][^>]*>/g;', tests: ['cleaner-tests.js'] },
  { id: 'M-HELD-CAT', what: 'a held block carries a category line', file: 'approval-briefing/lib/work-order-summary.js',
    from: 'function heldBlock() { return [HEADER, HELD_NOTICE]; }', to: "function heldBlock() { return [HEADER, '  Category (auto-sorted guess): Plumbing', HELD_NOTICE]; }", tests: ['run-tests.js'] },
  { id: 'M-HELD-PHRASE', what: 'the retired "held for privacy review" wording comes back', file: 'approval-briefing/lib/work-order-summary.js',
    from: "'  The title and description are not included in this email. Open", to: "'  The title and description are not included in this email (held for privacy review). Open", tests: ['run-tests.js'] },
  { id: 'M-UNASSIGNED', what: 'the unassigned pod gets the ordinary held sentence', file: 'approval-briefing/lib/work-order-summary.js',
    from: 'function unassignedBlock() { return [HEADER, UNASSIGNED_NOTICE]; }', to: 'function unassignedBlock() { return [HEADER, HELD_NOTICE]; }', tests: ['run-tests.js'] },
  { id: 'M-POD-READS', what: 'the unassigned pod path reads the text before deciding', file: 'approval-briefing/lib/work-order-summary.js',
    from: '    if (podUnassigned && screenOn) {\n      meta.cause', to: '    if (podUnassigned && screenOn) {\n      void (job && job.description);\n      meta.cause', tests: ['run-tests.js'] },
  { id: 'M-FIELDS', what: 'the summary reads a forbidden Latchel field', file: 'approval-briefing/lib/work-order-summary.js',
    from: '    const priority = priorityLabel(source);', to: '    void source.access_instructions;\n    const priority = priorityLabel(source);', tests: ['run-tests.js'] },
  { id: 'M-FOOTER', what: 'the shown block loses its fixed last line', file: 'approval-briefing/lib/work-order-summary.js',
    from: '    lines.push(SHOWN_FOOTER);\n', to: '', tests: ['run-tests.js'] },
  { id: 'M-WHOLE', what: 'a hit only withholds the field it was found in', file: 'approval-briefing/lib/work-order-summary.js',
    from: 'const first = runScreen(screen, { title, description, ...otherReadings });', to: 'const first = runScreen(screen, { title: \'\', description, spaced: { title: \'\', description: otherReadings.spaced.description } });', tests: ['run-tests.js'] },
  { id: 'M-SHADOW', what: 'shadow mode puts the block in the email', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "return mode === 'on' ? summary.lines : null;", to: 'return summary.lines;', tests: ['run-tests.js'] },
  { id: 'M-INTERLOCK', what: 'the ON interlock is ignored', file: 'approval-briefing/lib/work-order-summary.js',
    from: "return { mode: 'shadow', downgraded: true };", to: "return { mode: 'on', downgraded: false };", tests: ['run-tests.js'] },
  { id: 'M-MODE', what: 'an unrecognised mode value switches the feature on', file: 'approval-briefing/lib/work-order-summary.js',
    from: "  return { mode: 'off', downgraded: false };\n}", to: "  return { mode: v ? 'shadow' : 'off', downgraded: false };\n}", tests: ['run-tests.js'] },
  { id: 'M-AUDIT-KEY', what: 'the audit event gains a text-length field', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: '      on_downgraded: downgraded,\n    },', to: '      on_downgraded: downgraded,\n      text_length: 1,\n    },', tests: ['run-tests.js'] },
  { id: 'M-RISK', what: 'the unassigned pod is audited as medium risk', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "|| (summary.status === 'held' && m.cause !== 'pod_unassigned')\n    ||", to: "|| (summary.status === 'held')\n    ||", tests: ['run-tests.js'] },
  { id: 'M-RISK2', what: 'an unavailable lookup is audited as low risk', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "const medium = summary.status === 'unavailable'\n    ||", to: "const medium = false\n    ||", tests: ['run-tests.js'] },
  { id: 'M-COMMON', what: 'common_word_only is always true for a hold', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: 'if (!common) allCommon = false;', to: '', tests: ['screen-corpus.js'] },
  { id: 'M-LUHN', what: 'the card rule ignores the Luhn check', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: 'digits.length <= 19 && luhnOk(digits)', to: 'digits.length <= 19', tests: ['screen-corpus.js'] },
  { id: 'M-TIMEGUARD', what: 'the screen time guard never trips', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: 'return Number(process.hrtime.bigint() - started) / 1e6 > BUDGET_MS;', to: 'return false;', tests: ['screen-corpus.js'] },
  { id: 'M-MIXED', what: 'the mixed-script word rule is removed', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: 'if (LATIN_ONE.test(tok) && NOT_LATIN_ONE.test(tok)) { hit(\'unscreenable_language\', false); return; }', to: '', tests: ['screen-corpus.js'] },
  { id: 'M-CLEAN-TIMEGUARD', what: 'the cleaner time guard never trips', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "if (elapsedMs(started) > BUDGET_MS) throw new CleanError('clean_over_budget');", to: '', tests: ['cleaner-tests.js'] },
  { id: 'M-GUARD-EXPIRY', what: 'a stale in-flight entry blocks forever', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: 'if (t - existing.startedAtMs <= IN_FLIGHT_MAX_AGE_MS) {', to: 'if (true) {', tests: ['run-tests.js'] },
  { id: 'M-GUARD-TOKEN', what: 'a finished run deletes whatever entry is there', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: 'if (cur && cur.token === token) inFlightJobs.delete(guardKey);', to: 'inFlightJobs.delete(guardKey);', tests: ['run-tests.js'] },
  { id: 'M-GUARD-PRUNE', what: 'expired entries are never pruned', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: '    pruneInFlight(t);\n', to: '', tests: ['run-tests.js'] },
  { id: 'M-SENDERR', what: 'a send error is stored as-is while the block is active', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "    sendResult = { ...sendResult, error: safeSendError(sendResult.error) };", to: '', tests: ['run-tests.js'] },
  { id: 'M-SENDERR-SHADOW', what: 'a send error is reduced in shadow mode too (nothing needs hiding there)', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "descriptionMode() === 'on') {", to: "descriptionMode() !== 'off') {", tests: ['run-tests.js'] },
  { id: 'M-AUDITQUIET', what: 'the description audit write echoes a database error message', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "if (quietErrors) console.error(`[work-order-notes-alert] audit_log insert failed for ${action}.`);", to: 'if (false) console.error(\'x\');', tests: ['run-tests.js'] },
  { id: 'M-OFF-CHANGED', what: 'mode off changes the email', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: "    `Created: ${createdAt || '—'}`,", to: "    `Created: ${createdAt || '-'}`,", tests: ['run-tests.js'] },
  { id: 'M-FLAGCOL', what: 'the alert row flag column is set from the job text result', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: '    flagged_protected_class: false,', to: '    flagged_protected_class: !!(descriptionLines && descriptionLines.length === 2),', tests: ['run-tests.js'] },
  // ── second fix round ─────────────────────────────────────────────────────
  // R1 display fidelity
  { id: 'M-KEEP-TYPED', what: 'fractions, powers and the like are rewritten by NFKC again (2 1/2 shows as 21/2)', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "  if (!KEEP_AS_TYPED_TEST.test(s)) return s.normalize('NFKC');\n", to: "  return s.normalize('NFKC');\n", tests: ['fix-round-tests.js'] },
  // R2 links
  { id: 'M-SENTENCE-GUARD', what: 'a missing space after a full stop eats the next word again', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "  if (labels.length !== 2 || !SENTENCE_BREAK_ENDINGS.has(tldCore)) return false;\n", to: '  return false;\n', tests: ['fix-round-tests.js', 'round3-tests.js'] },
  { id: 'M-SENTENCE-LOOSE', what: 'the sentence guard also exempts lower-case look-alike addresses (rincon.support)', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "  if (!/^\\p{Lu}\\p{Ll}+$/u.test(origLast.split('-')[0])) return false;\n", to: '', tests: ['round3-tests.js'] },
  { id: 'M-LEADING-PUNCT', what: 'a leading dot, underscore or at-sign protects a web address again', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "'(?=[\\\\p{L}\\\\p{N}])(?<![\\\\p{L}\\\\p{N}])(?<![\\\\p{L}\\\\p{N}]-+)' +", to: "'(?<![\\\\p{L}\\\\p{N}@._\\\\-])' +", tests: ['fix-round-tests.js'] },
  { id: 'M-HYPHEN-RUN', what: 'a run of hyphens is no longer skipped as a whole (the host pattern goes quadratic on a long repeated hyphen run)', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "(?<![\\\\p{L}\\\\p{N}]-+)' +", to: "(?<![\\\\p{L}\\\\p{N}]-)' +", tests: ['fix-round-tests.js'] },
  { id: 'M-FIRST-CHAR', what: 'the cheap "a letter or digit is next" check is dropped (a long hyphen-only run is then walked back over at every position)', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "'(?=[\\\\p{L}\\\\p{N}])(?<![\\\\p{L}\\\\p{N}])", to: "'(?<![\\\\p{L}\\\\p{N}])", tests: ['fix-round-tests.js'] },
  { id: 'M-EMAIL-LOCAL', what: 'the part of an e-mail address before the at-sign is mangled', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "  if (!hasTail && after === '@' && domainAfterAtIsHost(whole, offset + m.length)) return m;\n", to: '', tests: ['cleaner-tests.js', 'fix-round-tests.js'] },
  { id: 'M-HYPHEN-TAIL', what: 'a hyphenated tail hides a web address (evil.com-login)', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "const tldCore = tld.split('-')[0];", to: 'const tldCore = tld;', tests: ['fix-round-tests.js'] },
  { id: 'M-UNITS', what: 'units written like domains (5.mm, 6.ml) are removed as links', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "  if (UNIT_ENDINGS.has(tldCore) && labels.slice(0, -1).every((l) => /^\\p{N}{1,4}$/u.test(l))) return false; // units: 5.mm, 3.cm, 6.ml, 2.5.mm\n", to: '', tests: ['fix-round-tests.js'] },
  { id: 'M-SECOND-LEVEL', what: 'multi-part country domains (evil.co.in) are no longer caught', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "  if (labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]) && /^[a-z]{2}$/.test(tldCore)) return true; // evil.co.in\n", to: '', tests: ['fix-round-tests.js'] },
  { id: 'M-EVERYDAY-CODE', what: 'hyphenated hosts on everyday two-letter endings (chase-verify.in) are no longer caught', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "  if (EVERYDAY_CODES.has(tldCore) && /[\\p{L}\\p{N}]-[\\p{L}\\p{N}]/u.test(labels[labels.length - 2])) {", to: "  if (false && EVERYDAY_CODES.has(tldCore) && /[\\p{L}\\p{N}]-[\\p{L}\\p{N}]/u.test(labels[labels.length - 2])) {", tests: ['fix-round-tests.js'] },
  { id: 'M-SCHEMES-NEW', what: 'skype:, facetime:, magnet: and the other added schemes are no longer neutralised', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "'skype|facetime|facetime-audio|callto|sips?|maps|geo|imessage|cid|about|view-source|ms-msdt|search-ms|magnet|whatsapp|tg|zoommtg|zoomus|itms|itms-apps|itms-services'", to: "'zzzzzz'", tests: ['fix-round-tests.js'] },
  // R3 unassigned code points
  { id: 'M-CN-CLEAN', what: 'the cleaner no longer removes unassigned code points', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "const INVISIBLE = /[\\p{Default_Ignorable_Code_Point}\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\p{Cn}\\u2800\\uFFFC]/gu;", to: "const INVISIBLE = /[\\p{Default_Ignorable_Code_Point}\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\u2800\\uFFFC]/gu;", tests: ['fix-round-tests.js', 'cleaner-tests.js'] },
  { id: 'M-CN-SCREEN', what: 'the screen\'s own fold no longer removes unassigned code points', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "const INVISIBLE = /[\\p{Default_Ignorable_Code_Point}\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\p{Cn}\\u2800\\uFFFC]/gu;", to: "const INVISIBLE = /[\\p{Default_Ignorable_Code_Point}\\p{Cc}\\p{Cf}\\p{Co}\\p{Cs}\\u2800\\uFFFC]/gu;", tests: ['fix-round-tests.js'] },
  // R4 slur literal outside the terms file (the mutant text is read from the terms file at run time, never written here)
  { id: 'M-SLUR-LITERAL', what: 'a slur is written in a code comment outside the terms file', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "'use strict';", to: `'use strict';\n// ${SLURS.find((x) => x.length >= 6)}`, tests: ['fix-round-tests.js'] },
  // R5 the job id
  { id: 'M-JOBID', what: 'any job id may be sent to Latchel', file: 'approval-briefing/lib/work-order-summary.js',
    from: 'if (fetchJob && JOB_ID_PATTERN.test(jobId)) detail', to: 'if (fetchJob && jobId) detail', tests: ['fix-round-tests.js'] },
  { id: 'M-JOBMATCH', what: 'the answer need not be the job that was asked for', file: 'approval-briefing/lib/work-order-summary.js',
    from: 'if (returnedId == null || String(returnedId) !== jobId) detail = null;', to: '', tests: ['fix-round-tests.js'] },
  // R6 the printed strings
  { id: 'M-RECHECK-LINK', what: 'the printed strings are not checked for a web-like fragment', file: 'approval-briefing/lib/work-order-summary.js',
    from: 'if (printed.some((x) => containsLink(x) || hasFoldedLink(x))) {', to: 'if (false) {', tests: ['fix-round-tests.js'] },
  { id: 'M-RECHECK-SCREEN', what: 'the cut strings are not screened again', file: 'approval-briefing/lib/work-order-summary.js',
    from: 'if ((shownTitle && shownTitle.cut) || (shownDescription && shownDescription.cut)) {', to: 'if (false) {', tests: ['fix-round-tests.js'] },
  { id: 'M-RECHECK-TITLE', what: 'the cut title is left out of the second screen call', file: 'approval-briefing/lib/work-order-summary.js',
    from: "title: shownTitle ? shownTitle.text : '',", to: "title: '',", tests: ['fix-round-tests.js'] },
  // R7 spaced reading
  { id: 'M-GLUE-SCREEN', what: 'the screen ignores the spaced reading', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "for (const [key, full] of [['spaced', true], ['symbols', false], ['both', false]]) {", to: "for (const [key, full] of [['symbols', false], ['both', false]]) {", tests: ['fix-round-tests.js'] },
  { id: 'M-GLUE-PASS', what: 'the summary does not hand the spaced reading (nor the fourth one, which falls back to it) to the screen', file: 'approval-briefing/lib/work-order-summary.js',
    from: 'const first = runScreen(screen, { title, description, ...otherReadings });', to: 'const first = runScreen(screen, { title, description, symbols: otherReadings.symbols });', tests: ['fix-round-tests.js'] },
  { id: 'M-GLUE-INVISIBLE', what: 'in the spaced reading a removed invisible character is not a space', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: ".replace(INVISIBLE, spaced ? ' ' : '');", to: ".replace(INVISIBLE, '');", tests: ['fix-round-tests.js'] },
  { id: 'M-GLUE-TAGS', what: 'in the spaced reading a removed tag is not a space', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: ".replace(ANY_TAG, spaced ? ' ' : '');", to: ".replace(ANY_TAG, '');", tests: ['fix-round-tests.js'] },
  { id: 'M-SPACED-BAD', what: 'a malformed extra reading (spaced, symbols or both) is quietly ignored', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "      if (typeof other !== 'object' || typeof other.title !== 'string' || typeof other.description !== 'string') return errorResult();\n", to: '', tests: ['fix-round-tests.js', 'round4-tests.js'] },
  // R8 shared phrases on the separator-folded copy
  { id: 'M-SHARED-LOCAL', what: 'the shared phrase list is not run on the word copy (any punctuation for a space)', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: '    if (words !== shared) sharedScan(words);\n', to: '', tests: ['fix-round-tests.js', 'round3-tests.js'], noSelfTest: true },
  // R9 look-alikes and digits
  { id: 'M-LATIN', what: 'look-alike Latin letters are no longer held', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: '    scanLookalikeLatin(shared, hit);\n', to: '', tests: ['fix-round-tests.js', 'screen-corpus.js'], noSelfTest: true },
  { id: 'M-DIGITS', what: 'digits of other scripts are not turned into 0-9', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: '  s = asciiDigits(s);\n', to: '', tests: ['fix-round-tests.js'], noSelfTest: true },
  // R10 language rule on the parts
  { id: 'M-LANG-PART', what: 'the unfamiliar-language rule runs on the whole text only', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: 'for (const part of [description, title]) {', to: 'for (const part of []) {', tests: ['fix-round-tests.js'] },
  // R11 notices
  { id: 'M-NOTICE', what: '"N day notice" patterns are removed', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: '    scanNoticePatterns(words, hit);\n', to: '', tests: ['fix-round-tests.js'] },
  // R12 / R13 / R17 terms and symbols
  { id: 'M-SYMBOLS', what: 'the symbol list is not consulted', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: '    scanSymbols(shared, hit);\n', to: '', tests: ['fix-round-tests.js', 'screen-corpus.js'], noSelfTest: true },
  { id: 'M-SYMBOL-ONE', what: 'one symbol (the wheelchair sign) is dropped from the list', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: 'cps: [0x267F, 0x1F9BD,', to: 'cps: [0x1F9BD,', tests: ['fix-round-tests.js'], noSelfTest: true },
  { id: 'M-V2-TERM', what: 'one added term (dvro) is dropped', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: '    dvro\n    tro\n', to: '    tro\n', tests: ['fix-round-tests.js'], noSelfTest: true },
  { id: 'M-V2-PAIR', what: 'the from-country pair rule is dropped', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: "const PAIR_RULES = PAIR_RULES_V1.concat(PAIR_RULES_V2_ADDITIONS, PAIR_RULES_V3_ADDITIONS, PAIR_RULES_V4_ADDITIONS);", to: 'const PAIR_RULES = PAIR_RULES_V1.concat(PAIR_RULES_V2_ADDITIONS.slice(1), PAIR_RULES_V3_ADDITIONS, PAIR_RULES_V4_ADDITIONS);', tests: ['fix-round-tests.js'] },
  { id: 'M-VERSION', what: 'the list version is not bumped', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: "const WO_SUPP_VERSION = 'wo-supp-v4';", to: "const WO_SUPP_VERSION = 'wo-supp-v3';", tests: ['run-tests.js', 'fix-round-tests.js'] },
  { id: 'M-V1-SLUR', what: 'a slur is dropped from the list (the text is read from the terms file at run time, never written here)', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: `'${SLURS[0]}', '${SLURS[1]}',`, to: `'${SLURS[1]}',`, tests: ['fix-round-tests.js', 'screen-corpus.js'] },
  // R14 / R15 / R16
  { id: 'M-WALLCLOCK', what: 'the same-job guard uses the wall clock again', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: 'let nowMs = monotonicNowMs;', to: 'let nowMs = () => Date.now();', tests: ['fix-round-tests.js'] },
  { id: 'M-NORECIPIENT', what: 'the block is built even when there is nobody to send to', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: 'const descriptionLines = recipients.length\n', to: 'const descriptionLines = true\n', tests: ['fix-round-tests.js'] },
  { id: 'M-THENABLE', what: 'a screen that answers with a promise leaves an unhandled rejection', file: 'approval-briefing/lib/work-order-summary.js',
    from: "if (verdict && typeof verdict.then === 'function') {", to: 'if (false) {', tests: ['fix-round-tests.js'] },
  { id: 'M-TERM-REMOVED', what: 'a term is loosened (removed) from the feature list', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: '    stay away order*\n', to: '', tests: ['fix-round-tests.js'] },
  { id: 'M-TERM-REMOVED-CORPUS', what: 'a term is loosened (removed) and a known-answer string has to notice it', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: '    dialysis\n', to: '', tests: ['screen-corpus.js'] },
  // ── third fix round ──────────────────────────────────────────────────────
  // R3-1 no category names stored
  { id: 'M3-CAT-AUDIT', what: 'the audit event gains a list of category names again', file: 'approval-briefing/lib/work-order-notes-alert.js',
    from: '      on_downgraded: downgraded,\n    },', to: "      on_downgraded: downgraded,\n      held_categories: ['x'],\n    },", tests: ['run-tests.js', 'round3-tests.js'] },
  { id: 'M3-CAT-META', what: 'the summary result carries the screen\'s category names again', file: 'approval-briefing/lib/work-order-summary.js',
    from: '    meta.common_word_only = verdict.common_word_only === true;', to: '    meta.common_word_only = verdict.common_word_only === true;\n    meta.held_categories = verdict.categories;', tests: ['round3-tests.js'] },
  { id: 'M3-CAT-LOG', what: 'the unsettled-text log line carries part of the error', file: 'approval-briefing/lib/work-order-summary.js',
    from: "console.error('[work-order-summary] The title or description did not settle in the cleaner - block held (unsettled_text).');", to: "console.error('[work-order-summary] The title or description did not settle in the cleaner - block held (unsettled_text).', String(source.description).slice(0, 40));", tests: ['round3-tests.js'] },
  // R3-2 any punctuation for a space, Section 8, squashed phrases
  { id: 'M3-SECTION8', what: 'the Section 8 rule is removed', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: '    scanSectionEight(tokens, hit);\n', to: '', tests: ['round3-tests.js'], noSelfTest: true },
  { id: 'M3-SECTION8-WINDOW', what: 'the Section 8 rule only looks at the very next word', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: 'EIGHT_WORDS.has(tokens[i + 1]) || EIGHT_WORDS.has(tokens[i + 2])', to: 'EIGHT_WORDS.has(tokens[i + 1])', tests: ['round3-tests.js'], noSelfTest: true },
  { id: 'M3-SQUASH', what: 'the squashed phrase check is removed', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: '    scanSquashed(tokens, hit);\n', to: '', tests: ['round3-tests.js'], noSelfTest: true },
  { id: 'M3-SQUASH-ONE', what: 'one phrase (restraining order) is dropped from the squashed list', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: "  { phrase: 'restraining order', cat: 'safety_violence' },\n", to: '', tests: ['round3-tests.js', 'screen-corpus.js'], noSelfTest: true },
  // R3-3 the link rule
  { id: 'M3-LINK-HOLD-OFF', what: 'a sentence-break shape no longer asks for a hold', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: '    if (sink && looksLikeSentenceBreak(labels, origLast, tldCore)) sink.ambiguousLink = true;\n', to: '', tests: ['fix-round-tests.js', 'round3-tests.js'] },
  { id: 'M3-LINK-HOLD-WIRE', what: 'the summary ignores the cleaner\'s request for a hold', file: 'approval-briefing/lib/work-order-summary.js',
    from: '    if (ambiguousLink) {', to: '    if (false) {', tests: ['fix-round-tests.js', 'round3-tests.js'] },
  { id: 'M3-LINK-SHOWN', what: 'a sentence-break shape is shown as typed again', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: '    if (sink && looksLikeSentenceBreak(labels, origLast, tldCore)) sink.ambiguousLink = true;\n    return true;', to: '    if (sink && looksLikeSentenceBreak(labels, origLast, tldCore)) { sink.ambiguousLink = true; return false; }\n    return true;', tests: ['fix-round-tests.js', 'round3-tests.js'] },
  { id: 'M3-AT-NAME', what: 'an at-sign with no name before it is a plain e-mail address again', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "if (!hasTail && before === '@' && hasNameBeforeAt(whole, offset - 1)) return m;", to: "if (!hasTail && before === '@') return m;", tests: ['round3-tests.js'] },
  { id: 'M3-AT-DOUBLE', what: 'a doubled at-sign still counts as a name before the at-sign', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "  return !(i > 0 && whole[i - 1] === '@');", to: '  return true;', tests: ['round3-tests.js'] },
  { id: 'M3-UNITS-ANY', what: 'any two-letter ending after a number is a unit again', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: 'if (UNIT_ENDINGS.has(tldCore) && labels.slice(0, -1)', to: 'if (tldCore.length === 2 && labels.slice(0, -1)', tests: ['round3-tests.js'] },
  { id: 'M3-EVERYDAY-HOLD', what: 'the Title-case everyday two-letter ending after a hyphenated word no longer asks for a hold', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: "    if (sink && /^\\p{Lu}\\p{Ll}$/u.test(origLast.split('-')[0])) sink.ambiguousLink = true;\n", to: '', tests: ['round3-tests.js'] },
  { id: 'M3-FOLDED-LINK', what: 'text whose NFKC reading is a web address is no longer held', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: '      if (hasFoldedLink(next)) sink.ambiguousLink = true;\n', to: '', tests: ['round3-tests.js'] },
  { id: 'M3-FOLDED-PRINTED', what: 'the printed strings are not checked for a folded web address', file: 'approval-briefing/lib/work-order-summary.js',
    from: 'containsLink(x) || hasFoldedLink(x)', to: 'containsLink(x)', tests: ['round3-tests.js'] },
  // R3-4 unsettled text
  { id: 'M3-UNSETTLED-CAUSE', what: 'text that will not settle is counted as a scanner error again', file: 'approval-briefing/lib/work-order-summary.js',
    from: "meta.cause = 'unsettled_text';\n        console.error", to: "meta.cause = 'check_error';\n        console.error", tests: ['cleaner-tests.js', 'round3-tests.js'] },
  { id: 'M3-UNSETTLED-ALL', what: 'every cleaner error is called unsettled text (a real scanner failure is hidden)', file: 'approval-briefing/lib/work-order-summary.js',
    from: "if (err && (err.code === 'clean_did_not_settle' || err.code === 'clean_over_budget')) {", to: 'if (true) {', tests: ['round3-tests.js', 'run-tests.js'] },
  { id: 'M3-PASSES', what: 'the cleaner gets only three passes (ordinary double-escaped text will not settle)', file: 'approval-briefing/lib/work-order-text-clean.js',
    from: 'const MAX_PASSES = 6;', to: 'const MAX_PASSES = 3;', tests: ['cleaner-tests.js', 'round3-tests.js'] },
  // R3-5 notices
  { id: 'M3-NOTICE-GLUED', what: 'a number glued to the word day ("3day notice") is no longer a notice', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "new RegExp(`${B}${NUM_EN} ?${QUAL_EN}days? (?:written )?(?:notices?|${CURE_EN})${E}`, 'u'),", to: "new RegExp(`${B}${NUM_EN} ${QUAL_EN}days? (?:written )?(?:notices?|${CURE_EN})${E}`, 'u'),", tests: ['round3-tests.js'], noSelfTest: true },
  { id: 'M3-NOTICE-QUAL', what: 'business / calendar / court / working days are no longer notices', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "const QUAL_EN = '(?:(?:business|calendar|court|working) )?';", to: "const QUAL_EN = '';", tests: ['round3-tests.js'], noSelfTest: true },
  { id: 'M3-NOTICE-HOURS', what: 'a notice in hours to quit or vacate is no longer held', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "new RegExp(`${B}${NUM_EN} ?${QUAL_EN}hours? (?:written )?(?:notices? )?${CURE_EN}${E}`, 'u'),", to: '', tests: ['round3-tests.js'], noSelfTest: true },
  { id: 'M3-NOTICE-HOURS-LOOSE', what: 'every notice in hours is held (an ordinary entry notice)', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "hours? (?:written )?(?:notices? )?${CURE_EN}${E}", to: "hours? (?:written )?(?:notices?|${CURE_EN})${E}", tests: ['round3-tests.js'], noSelfTest: true },
  { id: 'M3-NOTICE-OF', what: '"notice of N days" is no longer held', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "new RegExp(`${B}notices? (?:(?:of|for|is) )?", to: "new RegExp(`${B}notices? zzzz (?:(?:of|for|is) )?", tests: ['round3-tests.js'], noSelfTest: true },
  { id: 'M3-NOTICE-ES', what: 'the Spanish "N dias de aviso" form is no longer held', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "dias?(?: (?:habiles|calendario|naturales|corridos))? de (?:avisos?|notificacion|notificaciones)${E}", to: "dias?(?: (?:habiles|calendario|naturales|corridos))? de zzzz${E}", tests: ['round3-tests.js'], noSelfTest: true },
  // R3-6 vocabulary
  { id: 'M3-SLUR-PLURAL', what: 'a plural -s on a single-word slur is no longer held', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "if (swapped.length > 3 && swapped.endsWith('s')) forms.push(swapped.slice(0, -1));", to: '', tests: ['round3-tests.js'] },
  { id: 'M3-SLUR-PLURAL-ES', what: 'a plural -es on a single-word slur is no longer held', file: 'approval-briefing/lib/work-order-text-screen.js',
    from: "if (swapped.length > 3 && swapped.endsWith('es')) forms.push(swapped.slice(0, -2));", to: '', tests: ['round3-tests.js'] },
  { id: 'M3-V3-TERM', what: 'one added v3 term (me pega) is dropped', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: '    me pega\n', to: '', tests: ['screen-corpus.js', 'round3-tests.js'], noSelfTest: true },
  { id: 'M3-V3-PAIR', what: 'the Spanish "from a country" pair rule is dropped', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: 'PAIR_RULES_V1.concat(PAIR_RULES_V2_ADDITIONS, PAIR_RULES_V3_ADDITIONS, PAIR_RULES_V4_ADDITIONS)', to: 'PAIR_RULES_V1.concat(PAIR_RULES_V2_ADDITIONS, PAIR_RULES_V4_ADDITIONS)', tests: ['round3-tests.js', 'screen-corpus.js'], noSelfTest: true },
  { id: 'M3-V3-SYMBOL', what: 'the medical symbol is dropped from the added pictographs', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: "{ cat: 'disability_health', cps: [0x2695, 0x1F9AE] },", to: "{ cat: 'disability_health', cps: [0x1F9AE] },", tests: ['round3-tests.js', 'screen-corpus.js'], noSelfTest: true },
  { id: 'M3-V3-ORDINARY', what: 'an ordinary Spanish repair word (multa) is added to the list', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: '    cobra pension\n', to: '    cobra pension\n    multa\n', tests: ['screen-corpus.js', 'round3-tests.js'], noSelfTest: true },
  { id: 'M3-V2-PLURAL', what: 'a v2 plural term (blacks) is dropped (the v2 snapshot must notice)', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: '    blacks\n    whites\n', to: '    whites\n', tests: ['fix-round-tests.js'], noSelfTest: true },
  { id: 'M3-LETTERING', what: 'the look-alike lettering range is dropped from the symbol list (TARS\'s one surviving mutant)', file: 'approval-briefing/lib/work-order-text-screen-terms.js',
    from: "  { cat: 'unscreenable_language', ranges: [[0x1F150, 0x1F189]] },", to: '', tests: ['fix-round-tests.js', 'screen-corpus.js'], noSelfTest: true },
  // S3-3 quotes
  { id: 'M3-QUOTE', what: 'a double quote in the text is shown as typed again', file: 'approval-briefing/lib/work-order-summary.js',
    from: "return text.replace(/\"/g, '\\u2033');", to: 'return text;', tests: ['round3-tests.js'] },
  { id: 'M3-QUOTE-TITLE', what: 'a double quote in the title is shown as typed', file: 'approval-briefing/lib/work-order-summary.js',
    from: '  Title: ${quoteSafe(shownTitle.text)}', to: '  Title: ${shownTitle.text}', tests: ['round3-tests.js'] },
  // ── fourth fix round: symbols that stand for letters, at-sign hosts, the pinned v3 list, the v4 words, TARS's surviving mutants, the link_shape cause ──
  { id: "M4-SYM-OFF", what: "a symbol that stands for letters is no longer turned into a space (cleaner and screen)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "return s.replace(SEPARATOR_CANDIDATE, (ch) => (foldsToLetters(ch) ? ' ' : ch));", to: "return s;", tests: ["round4-tests.js", "screen-corpus.js"] },
  { id: "M4-SYM-READING-OFF", what: "the cleaner does not produce the symbols reading", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "const symbols = hasSymbols ? settle(value, false, started, undefined, ignored, true) : shown;", to: "const symbols = shown;", tests: ["round4-tests.js"] },
  { id: "M4-SYM-BOTH-OFF", what: "the cleaner does not produce the fourth reading (spaced and symbols together)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "const both = hasSymbols ? (probe.removal ? settle(value, true, started, undefined, ignored, true) : symbols) : spaced;", to: "const both = spaced;", tests: ["round4-tests.js"] },
  { id: "M4-SYM-SCREEN-OFF", what: "the screen makes no typed-symbol reading of its own", file: "approval-briefing/lib/work-order-text-screen.js",
    from: "    if (typed !== text) {", to: "    if (false) {", tests: ["screen-corpus.js"] },
  { id: "M4-SYM-PASS", what: "the summary does not hand the symbols readings to the screen", file: "approval-briefing/lib/work-order-summary.js",
    from: "const first = runScreen(screen, { title, description, ...otherReadings });", to: "const first = runScreen(screen, { title, description, spaced: otherReadings.spaced });", tests: ["round4-tests.js"] },
  { id: "M4-SYM-BOTH-PASS", what: "the summary does not hand the fourth reading to the screen", file: "approval-briefing/lib/work-order-summary.js",
    from: "const first = runScreen(screen, { title, description, ...otherReadings });", to: "const first = runScreen(screen, { title, description, spaced: otherReadings.spaced, symbols: otherReadings.symbols });", tests: ["round4-tests.js"] },
  { id: "M4-SYM-SPELLED", what: "circled, parenthesised and squared letters are turned into spaces too", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "v = !(rest.length === 1 && /^\\p{L}$/u.test(rest[0]));", to: "v = true;", tests: ["round4-tests.js"] },
  { id: "M4-SYM-DIGITS", what: "digit-like marks (superscripts, fractions) are turned into spaces too", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "const SEPARATOR_CANDIDATE = /(?![\\x00-\\x7F])[\\p{P}\\p{S}\\p{Z}\\u00AA\\u00BA\\u00B5\\u207F]/gu;\nconst LETTER_MARKS = new Set(['\\u00AA', '\\u00BA', '\\u00B5', '\\u207F']);", to: "const SEPARATOR_CANDIDATE = /(?![\\x00-\\x7F])[\\p{P}\\p{S}\\p{Z}\\u00AA\\u00BA\\u00B5\\u207F\\u00B2\\u00B3\\u00B9\\u00BC-\\u00BE]/gu;\nconst LETTER_MARKS = new Set(['\\u00AA', '\\u00BA', '\\u00B5', '\\u207F', '\\u00B2', '\\u00B3', '\\u00B9', '\\u00BC', '\\u00BD', '\\u00BE']);", tests: ["round4-tests.js"] },
  { id: "M4-SYM-ORDINAL", what: "the ordinal marks, the micro sign and the superscript n are no longer read as spaces", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "const LETTER_MARKS = new Set(['\\u00AA', '\\u00BA', '\\u00B5', '\\u207F']);", to: "const LETTER_MARKS = new Set([]);", tests: ["round4-tests.js"] },
  { id: "M4-SECTION-SIGN", what: "the section sign is no longer read as the word section", file: "approval-briefing/lib/work-order-text-screen.js",
    from: "if (t.includes('\\u00A7')) t = t.replace(/\\u00A7/g, ' section ');", to: "", tests: ["round4-tests.js", "screen-corpus.js"] },
  { id: "M4-AT-ANY", what: "the part in front of an at-sign is left alone whatever follows the at-sign again", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "if (!hasTail && after === '@' && domainAfterAtIsHost(whole, offset + m.length)) return m;", to: "if (!hasTail && after === '@' && /[\\p{L}\\p{N}]/u.test(whole[offset + m.length + 1] || '')) return m;", tests: ["round4-tests.js"] },
  { id: "M4-AT-ANYENDING", what: "after the at-sign any dotted name counts as a host, not only a listed ending", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "return TLDS.has(ending) || EVERYDAY_CODES.has(ending);   // (EMAIL_DOMAIN already needs at least one dot)", to: "return true;", tests: ["round4-tests.js"] },
  { id: "M4-AT-DOT-OPTIONAL", what: "after the at-sign a single label counts as a host", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "const EMAIL_DOMAIN = /(?:[\\p{L}\\p{N}][\\p{L}\\p{N}-]*[.\\u3002])+[\\p{L}\\p{N}][\\p{L}\\p{N}-]*/uy;", to: "const EMAIL_DOMAIN = /(?:[\\p{L}\\p{N}][\\p{L}\\p{N}-]*[.\\u3002])*[\\p{L}\\p{N}][\\p{L}\\p{N}-]*/uy;", tests: ["round4-tests.js"] },
  { id: "M4-HOSTEND-OFF", what: "the host no longer ends at a non-ASCII character after its ending", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "const cut = asciiHostEnd(host);", to: "const cut = -1;", tests: ["round4-tests.js"] },
  { id: "M4-HOSTEND-HYPHEN", what: "a hyphen after the ending cuts the host (the tail is left behind)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "return next === '-' ? -1 : lastDot + 1 + ascii[0].length;", to: "return lastDot + 1 + ascii[0].length;", tests: ["round4-tests.js"] },
  { id: "M4-HOSTEND-LATIN", what: "accented letters and other-script digits after the ending count as part of the host again", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "const ascii = /^[A-Za-z0-9]+/.exec(label);", to: "const ascii = /^[\\p{L}\\p{N}]+/u.exec(label);", tests: ["round4-tests.js"] },
  { id: "M4-V3-HURTING", what: "a v3 term is deleted (hurting me)", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "    hurting me\n    hurting her\n", to: "    hurting her\n", tests: ["fix-round-tests.js", "round4-tests.js"] },
  { id: "M4-V3-PENSION", what: "a v3 Spanish term is deleted (tiene pension)", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "    tiene pension\n", to: "", tests: ["fix-round-tests.js", "round4-tests.js"] },
  { id: "M4-V3-GUN", what: "a v3 term is deleted (had a gun)", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "    had a gun\n", to: "", tests: ["fix-round-tests.js", "round4-tests.js"] },
  { id: "M4-V3-FLAG", what: "a v3 term gets the common mark", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "    hurting me\n    hurting her\n", to: "    hurting me [c]\n    hurting her\n", tests: ["fix-round-tests.js", "round4-tests.js"] },
  { id: "M4-V3-PAIRWORD", what: "a word is deleted from the v3 pair rule", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "'originario', 'originaria', 'oriundo', 'oriunda', 'natural', 'naturales',", to: "'originario', 'originaria', 'oriundo', 'oriunda', 'naturales',", tests: ["fix-round-tests.js", "round4-tests.js"] },
  { id: "M4-V4-TERM-EN", what: "a v4 term is deleted (molested)", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "    molested\n    molester\n", to: "    molester\n", tests: ["round4-tests.js", "screen-corpus.js"] },
  { id: "M4-V4-TERM-ES", what: "a v4 Spanish term is deleted (no tengo papeles)", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "    no tengo papeles\n", to: "", tests: ["round4-tests.js", "screen-corpus.js"] },
  { id: "M4-V4-TERM-S8", what: "a v4 Section 8 term is deleted (hqs)", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "    hqs\n", to: "", tests: ["round4-tests.js", "screen-corpus.js"] },
  { id: "M4-V4-NOUN-EN", what: "the English violence rule loses a person noun (wife)", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "'wife', 'husband', 'girlfriend',", to: "'husband', 'girlfriend',", tests: ["round4-tests.js", "screen-corpus.js"] },
  { id: "M4-V4-VERB-EN", what: "the English violence rule loses its verbs hit and hits", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "  'hit', 'hits', 'hitting', 'beat',", to: "  'hitting', 'beat',", tests: ["round4-tests.js", "screen-corpus.js"] },
  { id: "M4-V4-NOUN-ES", what: "the Spanish violence rule loses a person noun (esposa)", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "  'esposa', 'esposo', 'mujer',", to: "  'esposo', 'mujer',", tests: ["round4-tests.js"] },
  { id: "M4-V4-FIRSTPERSON", what: "the first-person Spanish rule loses soy", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "a: ['soy', 'eres',", to: "a: ['eres',", tests: ["round4-tests.js", "screen-corpus.js"] },
  { id: "M4-V4-RULES-OFF", what: "the v4 pair rules are not used", file: "approval-briefing/lib/work-order-text-screen-terms.js",
    from: "PAIR_RULES_V3_ADDITIONS, PAIR_RULES_V4_ADDITIONS);", to: "PAIR_RULES_V3_ADDITIONS);", tests: ["round4-tests.js", "fix-round-tests.js", "screen-corpus.js"] },
  { id: "M4-HOURS-OFF", what: "the hour-based notice pattern (to perform, to cure) is removed", file: "approval-briefing/lib/work-order-text-screen.js",
    from: "  new RegExp(`${B}${NUM_EN} ?${QUAL_EN}hours? (?:written )?(?:notices? )?${CURE_EN}${E}`, 'u'),\n", to: "", tests: ["round4-tests.js"] },
  { id: "M4-AMB-ANYCHAIN", what: "the sentence-break shape is flagged for longer chains too (a.b.Info)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "if (labels.length !== 2 || !SENTENCE_BREAK_ENDINGS.has(tldCore)) return false;", to: "if (labels.length < 2 || !SENTENCE_BREAK_ENDINGS.has(tldCore)) return false;", tests: ["round4-tests.js"] },
  { id: "M4-AMB-ANYLABEL", what: "the sentence-break shape is flagged for any first label (5B.Info)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "return /^(?:\\p{L}+|\\p{N}+)$/u.test(labels[0]);", to: "return true;", tests: ["round4-tests.js"] },
  { id: "M4-LINKSHAPE-CAUSE", what: "a cleaner-requested hold is recorded as a sensitive-word hold again", file: "approval-briefing/lib/work-order-summary.js",
    from: "meta.cause = 'link_shape';\n      return { status: 'held', lines: heldBlock(), meta };\n    }\n    if (!title && !description) {", to: "meta.cause = 'local_screen';\n      return { status: 'held', lines: heldBlock(), meta };\n    }\n    if (!title && !description) {", tests: ["round4-tests.js", "fix-round-tests.js"] },
  { id: "M4-LINKSHAPE-CUT", what: "a web-like fragment left by the cut is recorded as a sensitive-word hold again", file: "approval-briefing/lib/work-order-summary.js",
    from: "hold, with no category to name.\n      meta.cause = 'link_shape';", to: "hold, with no category to name.\n      meta.cause = 'local_screen';", tests: ["round4-tests.js", "fix-round-tests.js"] },

  // ─── The owner's switch that turns the content screen off (unscreened-tests.js) ───
  { id: "M5-SWITCH-ANYCASE", what: "the switch honours OFF, Off and ' off' too", file: "approval-briefing/lib/work-order-summary.js",
    from: "return process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN !== 'off';", to: "return !/^\\s*off\\s*$/i.test(process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN || '');", tests: ["unscreened-tests.js"] },
  { id: "M5-SWITCH-UNSETOFF", what: "an unset switch means the screen is off", file: "approval-briefing/lib/work-order-summary.js",
    from: "return process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN !== 'off';", to: "return process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN === 'on';", tests: ["unscreened-tests.js", "run-tests.js"] },
  { id: "M5-SWITCH-CACHED", what: "the switch is read once at load, not at each alert", file: "approval-briefing/lib/work-order-summary.js",
    from: "function descriptionScreenOn() {\n  return process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN !== 'off';\n}", to: "const SCREEN_ON_AT_LOAD = process.env.WORK_ORDER_ALERT_DESCRIPTION_SCREEN !== 'off';\nfunction descriptionScreenOn() {\n  return SCREEN_ON_AT_LOAD;\n}", tests: ["unscreened-tests.js"] },
  { id: "M5-MODEOFF-RUNS", what: "with the mode off the block still runs when the screen switch is off", file: "approval-briefing/lib/work-order-notes-alert.js",
    from: "  if (mode === 'off') return null;\n  if (downgraded) {", to: "  if (mode === 'off' && descriptionScreenOn()) return null;\n  if (downgraded) {", tests: ["unscreened-tests.js"] },
  { id: "M5-SHADOW-SENDS", what: "shadow mode with the screen off puts the block in the email", file: "approval-briefing/lib/work-order-notes-alert.js",
    from: "return mode === 'on' ? summary.lines : null;", to: "return (mode === 'on' || !descriptionScreenOn()) ? summary.lines : null;", tests: ["unscreened-tests.js"] },
  { id: "M5-SCREEN-CONSULTED", what: "the unscreened path still asks the word-list screen and holds on its answer", file: "approval-briefing/lib/work-order-summary.js",
    from: "    if (!title && !description) return { status: 'none', lines: [NONE_LINE], meta };\n\n    meta.truncated = cpLen(title)", to: "    if (!title && !description) return { status: 'none', lines: [NONE_LINE], meta };\n    if (runScreen(screenOverride || screenWorkOrderText, { title, description }).status !== 'cleared') { meta.cause = 'local_screen'; return { status: 'held', lines: heldBlock(), meta }; }\n\n    meta.truncated = cpLen(title)", tests: ["unscreened-tests.js"] },
  { id: "M5-HOLD-LINKSHAPE", what: "a cleaner-requested hold is kept with the screen off (the sentence-break shape holds the block)", file: "approval-briefing/lib/work-order-summary.js",
    from: "    if (!title && !description) return { status: 'none', lines: [NONE_LINE], meta };\n\n    meta.truncated = cpLen(title)", to: "    if (!title && !description) return { status: 'none', lines: [NONE_LINE], meta };\n    if (title.includes('[link removed]') || description.includes('[link removed]')) { meta.cause = 'link_shape'; return { status: 'held', lines: heldBlock(), meta }; }\n\n    meta.truncated = cpLen(title)", tests: ["unscreened-tests.js"] },
  { id: "M5-FALLBACK-HELD", what: "text that cannot be printed is held (the held sentence) instead of the neutral line", file: "approval-briefing/lib/work-order-summary.js",
    from: "    return { status: 'unavailable', lines: [UNAVAILABLE_LINE], meta };\n  }\n\n  let categoryLabel = null;", to: "    return { status: 'held', lines: heldBlock(), meta };\n  }\n\n  let categoryLabel = null;", tests: ["unscreened-tests.js"] },
  { id: "M5-UNASSIGNED-POINTER", what: "an unassigned pod is still pointer-only with the screen off", file: "approval-briefing/lib/work-order-summary.js",
    from: "if (podUnassigned && screenOn) {", to: "if (podUnassigned) {", tests: ["unscreened-tests.js"] },
  { id: "M5-VERSION", what: "an unscreened row is not marked with the unscreened version", file: "approval-briefing/lib/work-order-summary.js",
    from: "  if (!screenOn) meta.screen_version = UNSCREENED_VERSION;\n", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-FOOTER-OLD", what: "the unscreened block keeps the old 'Not checked for names' last line", file: "approval-briefing/lib/work-order-summary.js",
    from: "  lines.push(UNSCREENED_FOOTER);\n  return { status: 'shown', lines, meta };", to: "  lines.push(SHOWN_FOOTER);\n  return { status: 'shown', lines, meta };", tests: ["unscreened-tests.js"] },
  { id: "M5-RISK-LOW", what: "an unscreened shown row is audited as low risk", file: "approval-briefing/lib/work-order-notes-alert.js",
    from: "\n    || m.screen_version === UNSCREENED_VERSION;", to: ";", tests: ["unscreened-tests.js"] },
  { id: "M5-AUDIT-KEY", what: "the audit event gains a text-length field (unscreened tests)", file: "approval-briefing/lib/work-order-notes-alert.js",
    from: '      on_downgraded: downgraded,\n    },', to: '      on_downgraded: downgraded,\n      text_length: 1,\n    },', tests: ["unscreened-tests.js"] },
  { id: "M5-CATCH-VERSION", what: "the summary-error audit row keeps the screen version even with the screen off", file: "approval-briefing/lib/work-order-notes-alert.js",
    from: "screen_version: descriptionScreenOn() ? SCREEN_VERSION : UNSCREENED_VERSION,", to: "screen_version: SCREEN_VERSION,", tests: ["unscreened-tests.js"] },
  { id: "M5-LOG-TEXT", what: "the safety fallback logs the job text", file: "approval-briefing/lib/work-order-summary.js",
    from: "console.error('[work-order-summary] The title or description could not be made safe to print - showing the unavailable line (unprintable_text).');", to: "console.error('[work-order-summary] The title or description could not be made safe to print - showing the unavailable line (unprintable_text).', String(source.description));", tests: ["unscreened-tests.js"] },
  { id: "M5-NET", what: "the unscreened path makes a network call with the text", file: "approval-briefing/lib/work-order-summary.js",
    from: "    title = cleanTextUnscreened(source.name);", to: "    try { global.fetch('https://example.invalid/x', { method: 'POST', body: String(source.description) }); } catch (_e) { /* ignored */ }\n    title = cleanTextUnscreened(source.name);", tests: ["unscreened-tests.js", "no-ai-proof.js"] },
  { id: "M5-FIELDS", what: "the unscreened path reads a forbidden Latchel field", file: "approval-briefing/lib/work-order-summary.js",
    from: "  const priority = priorityLabel(source);\n  if (priority) lines.push(`  Priority: ${priority} (flagged in Latchel)`);\n  if (shownDescription) {\n    lines.push(`  Description: \"${quoteSafe(shownDescription.text)}\"${shownDescription.cut ? CUT_POINTER : ''}`);\n  } else {\n    lines.push(`  Description: ${NO_DESCRIPTION}`);\n  }\n  lines.push(UNSCREENED_FOOTER);", to: "  void source.access_instructions;\n  const priority = priorityLabel(source);\n  if (priority) lines.push(`  Priority: ${priority} (flagged in Latchel)`);\n  if (shownDescription) {\n    lines.push(`  Description: \"${quoteSafe(shownDescription.text)}\"${shownDescription.cut ? CUT_POINTER : ''}`);\n  } else {\n    lines.push(`  Description: ${NO_DESCRIPTION}`);\n  }\n  lines.push(UNSCREENED_FOOTER);", tests: ["unscreened-tests.js"] },
  { id: "M5-FIT-BOUND", what: "the cut text may grow past the limit when a fragment is replaced", file: "approval-briefing/lib/work-order-summary.js",
    from: "    if (n <= room) return { text: out, cut: true };", to: "    return { text: out, cut: true };", tests: ["unscreened-tests.js"] },
  { id: "M5-CUT-NOT-CLEANED", what: "the cut text is not cleaned and masked again", file: "approval-briefing/lib/work-order-summary.js",
    from: "    const out = cleanTextUnscreened(truncate(text, lim).text);", to: "    const out = truncate(text, lim).text;", tests: ["unscreened-tests.js"] },
  { id: "M5-FOLDED-LINK", what: "a link that exists only in the NFKC reading is no longer replaced", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (hasFoldedLink(next)) next = neutraliseLinks(next.normalize('NFKC'));\n    next = cleanText(next);\n    if (next === cur && !hasFoldedLink(cur)) return cur;", to: "    next = cleanText(next);\n    if (next === cur) return cur;", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-OFF", what: "the never-store mask does nothing", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  if (typeof s !== 'string' || !s) return s;\n  let out = maskSocialByWord(s);", to: "  return s;\n  let out = maskSocialByWord(s);", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-PASSWORD", what: "passwords are not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  out = maskPasswords(out);\n", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-SSN", what: "a separated SSN is not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    raw.push(...social);\n", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-SSN-WORD", what: "nine digits after 'ssn' are not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  let out = maskSocialByWord(s);", to: "  let out = s;", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-CARD", what: "card numbers are not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  const raw = cardWindows(groups);\n  const social = socialSpans(groups);", to: "  const raw = [];\n  const social = socialSpans(groups);", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-CARD-WORD", what: "numbers after the word 'card' are not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  out = maskCardsByWord(out);\n", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-ACCOUNT", what: "account and routing numbers are not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  out = maskAccountNumbers(out);\n", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-IBAN", what: "IBANs are not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  out = maskIbans(out);\n", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-SWIFT", what: "SWIFT codes are not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  out = maskSwiftCodes(out);\n", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-CVV", what: "card security codes are not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  out = maskSecurityCodes(out);\n", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-LUHN", what: "a 13 to 19 digit run is masked without a check digit", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "      if (luhnOk(bestDigits)) hits.push([i, best]);", to: "      hits.push([i, best]);", tests: ["unscreened-tests.js", "mask-tests.js"] },
  { id: "M5-MASK-SHAPE", what: "a card number is masked only in one group or written 4-4-4-4 (the narrow rule TARS found)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "      if (luhnOk(bestDigits)) hits.push([i, best]);", to: "      if (luhnOk(bestDigits) && (best === i || (best - i === 3 && groups.slice(i, best + 1).every((x) => x.digits.length === 4)))) hits.push([i, best]);", tests: ["mask-tests.js"] },
  { id: "M5-MASK-PW-STOP", what: "everyday words after 'password is' are masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (v.stop || v.keyword) continue;                              // an everyday word, or the keyword of another rule, is not a password\n", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-PW-BARE", what: "any word after 'password' is masked, even without a colon, equals sign or 'is'", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (!assigned && !v.secretLooking) continue;", to: "", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-PHONE", what: "a phone number after 'account' is masked as an account number", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  return !(PHONE_SHAPE.test(v) || isRealDate(v));", to: "  return true;", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-MINDIGITS", what: "a 2 digit number after 'account' is masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  if (digitsOf(v).length < 6) return false;", to: "  if (digitsOf(v).length < 2) return false;", tests: ["unscreened-tests.js"] },
  { id: "M5-MASK-SWIFT-WORD", what: "any 8 letter word after 'swift code' is masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "(!SWIFT_NOT_A_CODE.test(code) && (/\\p{Nd}/u.test(code) || code === code.toUpperCase()) ? head + MASK_TEXT : m)", to: "(head + MASK_TEXT)", tests: ["unscreened-tests.js"] },
  { id: "M5-UNSCREENED-SETTLE", what: "the unscreened cleaning runs once and does not repeat until stable", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (next === cur && !hasFoldedLink(cur)) return cur;\n    cur = next;", to: "    return next;\n    cur = next;", tests: ["unscreened-tests.js"] },
  // ─── Round 5: cards in any grouping, no unit-number false masks, honest last line, password / SWIFT / date rules ───
  { id: "M6-CARD-PREFIX", what: "a group of four 4-digit numbers is masked because its first digits look like a card (the rule TARS and Judge removed)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "      if (luhnOk(bestDigits)) hits.push([i, best]);", to: "      if (luhnOk(bestDigits) || (best - i === 3 && groups.slice(i, best + 1).every((x) => x.digits.length === 4) && /^(?:4|5[1-5]|2[2-7]|6011|65|3[47])/.test(bestDigits))) hits.push([i, best]);", tests: ["mask-tests.js"] },
  { id: "M6-CARD-ALLWINDOWS", what: "after a window fails the check digit the next window starts one group later (every window of a number list is tested, not one per run like the screen)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "      if (luhnOk(bestDigits)) hits.push([i, best]);\n      i = best + 1;", to: "      if (luhnOk(bestDigits)) { hits.push([i, best]); i = best + 1; } else i++;", tests: ["mask-tests.js"] },
  { id: "M6-CARD-MAX18", what: "a 19 digit card number is not masked (window of at most 18 digits)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "      if (total > 19) break;", to: "      if (total > 18) break;", tests: ["mask-tests.js"] },
  { id: "M6-CARD-MIN14", what: "a 13 digit card number is not masked (window of at least 14 digits)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "      if (total >= 13) { best = j; bestDigits = digits; }", to: "      if (total >= 14) { best = j; bestDigits = digits; }", tests: ["mask-tests.js"] },
  { id: "M6-CARD-AFTER-SSN", what: "the separated SSN rule runs BEFORE the card rule, as two rules (a card number with a 3-2-4 stretch is only partly masked)", file: "approval-briefing/lib/work-order-text-clean.js",
    edits: [
      ["function socialSpans(groups) {\n  const spans = [];", "function socialSpans(groups) {\n  const spans = [];\n  return spans;"],
      ["function maskCardsAndSocial(s) { return s.replace(DIGIT_RUN, (run) => maskCardRun(run)); }", "function maskCardsAndSocial(s) { return s.replace(/(?<!\\p{Nd})\\p{Nd}{3}[ \\-\\u2010-\\u2015\\u2212]\\p{Nd}{2}[ \\-\\u2010-\\u2015\\u2212]\\p{Nd}{4}(?!\\p{Nd})/gu, MASK_TEXT).replace(DIGIT_RUN, (run) => maskCardRun(run)); }"],
    ], tests: ["mask-tests.js"] },
  { id: "M6-CARD-ONE-GROUP-ONLY", what: "a card number is masked only when written as one group (every grouping gap is back)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "      if (luhnOk(bestDigits)) hits.push([i, best]);", to: "      if (luhnOk(bestDigits) && best === i) hits.push([i, best]);", tests: ["mask-tests.js"] },
  { id: "M6-CARD-LAYOUTS-OFF", what: "a card written the usual way is no longer found when it follows another number (the second reading is gone)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (found >= 0) hits.push([a, found]);", to: "", tests: ["mask-tests.js"] },
  { id: "M6-CARD-LAYOUT-NOLUHN", what: "a group of four 4-digit numbers inside a longer run is masked without a check digit", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "isCardLayout(groups, a, j) && luhnOk(digits)", to: "isCardLayout(groups, a, j)", tests: ["mask-tests.js"] },
  { id: "M6-CARD-LAYOUT-ANY", what: "the second reading tests every window of a long list, not only the usual card layouts (three-digit unit lists go above the old screen's rate)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  return fourFourFour || amex;", to: "  return true;", tests: ["mask-tests.js"] },
  { id: "M6-PW-FILLERS-OFF", what: "filler words between 'password' and the value are not handled", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "return maskPasswordsRight(maskPasswordFillers(maskPasswordPhrases(s)));", to: "return maskPasswordsRight(maskPasswordPhrases(s));", tests: ["mask-tests.js"] },
  { id: "M6-PW-PHRASES-OFF", what: "an everyday first word after a colon is never followed into the passphrase", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "return maskPasswordsRight(maskPasswordFillers(maskPasswordPhrases(s)));", to: "return maskPasswordsRight(maskPasswordFillers(s));", tests: ["mask-tests.js"] },
  { id: "M6-PW-STATUS-NOTE", what: "a status note after 'password:' (mostly everyday words) is masked like a passphrase", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  if (others < 2 || others <= stops) return -1;", to: "", tests: ["mask-tests.js"] },
  { id: "M6-PW-TO-ANY", what: "any value after 'password reset to' is masked, not only a secret-looking one", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (weak && !v.secretLooking) continue;", to: "", tests: ["mask-tests.js"] },
  { id: "M6-PW-FILLER-LONG", what: "up to six filler words are allowed before 'is' too (a far-away 'is' masks an everyday word)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (k > 4 && !weak) continue;", to: "", tests: ["mask-tests.js"] },
  { id: "M6-PW-TO-SHORT", what: "'to' is read after at most four filler words (a far-away 'reset to' value leaks)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  for (let k = 0; k <= 6; k++) {\n    if (k > 0) {", to: "  for (let k = 0; k <= 4; k++) {\n    if (k > 0) {", tests: ["mask-tests.js"] },
  { id: "M6-PW-FILLER-ONEPARSE", what: "the first reading of a connector word is final (a stop-word value hides the real connector later)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (!v.hasValue || v.stop || v.keyword || PW_EMAIL.test(v.core)) continue;", to: "    if (!v.hasValue || v.stop || v.keyword || PW_EMAIL.test(v.core)) return null;", tests: ["mask-tests.js"] },
  { id: "M6-PW-EMAIL-GUARD", what: "an e-mail address after 'password reset sent to:' is masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: " || v.keyword || PW_EMAIL.test(v.core)) continue;", to: " || v.keyword) continue;", tests: ["mask-tests.js"] },
  { id: "M6-SWIFT-BARE", what: "SWIFT / BIC without the word 'code' or 'number' is not masked", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "${KW_END}){0,3}[", to: "${KW_END}){1,3}[", tests: ["mask-tests.js"] },
  { id: "M6-DATE-RANGE", what: "any date-shaped number after 'account' is left alone (no range check)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  return !(PHONE_SHAPE.test(v) || isRealDate(v));", to: "  return !(PHONE_SHAPE.test(v) || DATE_SHAPE.test(v));", tests: ["mask-tests.js"] },
  { id: "M6-DATE-YEAR", what: "a year-month-day shape is a date whatever the year", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  if (p[0].length === 4) return inYears(a) && b >= 1", to: "  if (p[0].length === 4) return b >= 1", tests: ["mask-tests.js"] },
  { id: "M6-FOOTER-CLAIM", what: "the unscreened last line claims that links, cards, bank, SSN and passwords are removed", file: "approval-briefing/lib/work-order-summary.js",
    from: "'  (Quoted from Latchel. Not screened; some links, cards, SSNs, passwords removed. Internal use only.)'", to: "'  (Quoted from Latchel. Not screened; links, cards, bank, SSN and passwords removed. Internal use only.)'", tests: ["unscreened-tests.js", "mask-tests.js"] },
  { id: "M6-FOOTER-LONG", what: "the unscreened last line is longer than 104 characters", file: "approval-briefing/lib/work-order-summary.js",
    from: "removed. Internal use only.)';\nconst UNSCREENED_VERSION", to: "removed. Internal use only, thanks.)';\nconst UNSCREENED_VERSION", tests: ["unscreened-tests.js"] },
  { id: "M6-STOP-SENT", what: "'sent' is no longer an everyday word after 'password ... was'", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  sent emailed texted called", to: "  emailed texted called", tests: ["mask-tests.js"] },
  // ─── Round 6: the SSN and the card in one pass, keyword rules before the password rules, "password to X", lists of passwords ───
  { id: "M7-CARD-THEN-SSN", what: "the old order of c205631: the card rule runs first and the separated SSN rule after it, as two rules (a bare SSN beside a card or a list of 4-digit numbers is left partly visible)", file: "approval-briefing/lib/work-order-text-clean.js",
    edits: [
      ["function socialSpans(groups) {\n  const spans = [];", "function socialSpans(groups) {\n  const spans = [];\n  return spans;"],
      ["function maskCardsAndSocial(s) { return s.replace(DIGIT_RUN, (run) => maskCardRun(run)); }", "function maskCardsAndSocial(s) { return s.replace(DIGIT_RUN, (run) => maskCardRun(run)).replace(/(?<!\\p{Nd})\\p{Nd}{3}[ \\-\\u2010-\\u2015\\u2212]\\p{Nd}{2}[ \\-\\u2010-\\u2015\\u2212]\\p{Nd}{4}(?!\\p{Nd})/gu, MASK_TEXT); }"],
    ], tests: ["mask-tests.js"] },
  { id: "M7-SSN-NOT-UNITED", what: "the card windows and the SSN spans are merged only when they share a group in the SAME rule (the SSN spans are added after the merge, so an overlap cuts one of them)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    raw.push(...social);\n  }\n  if (!raw.length) return run;", to: "  }\n  if (!raw.length) return run;\n  for (const sp of social) if (!raw.some((h) => h[0] <= sp[1] && sp[0] <= h[1])) raw.push(sp);", tests: ["mask-tests.js"] },
  { id: "M7-SSN-NO-RESTART", what: "a card is only read from the start of the run, never again from right after an SSN (a card that starts after an SSN, or ends before one, and contains a 3-2-4 stretch is cut)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "        const j = windowFrom(groups, p, stops[k]);\n        if (j >= 0) raw.push([p, j]);", to: "", tests: ["mask-tests.js"] },
  { id: "M7-SSN-NO-SEGMENTS", what: "the stretches between the SSNs are not read as runs of their own (a list of 4-digit numbers that fails the check digit, then a card, beside an SSN)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "      if (a > from) for (const [x, y] of cardWindows(groups.slice(from, a))) raw.push([x + from, y + from]);", to: "", tests: ["mask-tests.js"] },
  { id: "M7-SSN-SHAPE", what: "an SSN-shaped stretch is 3-2-3 digits instead of 3-2-4 (the last digit of an SSN is left)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "groups[a + 2].digits.length === 4) { spans.push", to: "groups[a + 2].digits.length === 3) { spans.push", tests: ["unscreened-tests.js", "mask-tests.js"] },
  { id: "M7-PW-FIRST", what: "the password rules run before the rules that need a keyword (a password phrase can take the first word of a two-word keyword such as 'american express' and leave its number)", file: "approval-briefing/lib/work-order-text-clean.js",
    edits: [
      ["  let out = maskSocialByWord(s);", "  let out = maskPasswords(s);\n  out = maskSocialByWord(out);"],
      ["  out = maskSwiftCodes(out);\n  out = maskPasswords(out);\n  out = maskIbans(out);", "  out = maskSwiftCodes(out);\n  out = maskIbans(out);"],
    ], tests: ["mask-tests.js"] },
  { id: "M7-IBAN-BEFORE-PW", what: "the IBAN rule runs before the password rules (its value runs on over the next words and swallows a following 'password' word, leaving the password)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  out = maskPasswords(out);\n  out = maskIbans(out);", to: "  out = maskIbans(out);\n  out = maskPasswords(out);", tests: ["mask-tests.js"] },
  { id: "M7-PW-VALUE-KEYWORD", what: "the third password reading takes another rule's keyword (iban, ssn, account ...) as its value", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (v.stop || v.keyword) continue;                              // an everyday word, or the keyword of another rule, is not a password", to: "    if (v.stop) continue;", tests: ["mask-tests.js"] },
  { id: "M7-PW-FILLER-KEYWORD", what: "the filler-word reading takes another rule's keyword as its value", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (!v.hasValue || v.stop || v.keyword || PW_EMAIL.test(v.core)) continue;", to: "    if (!v.hasValue || v.stop || PW_EMAIL.test(v.core)) continue;", tests: ["mask-tests.js"] },
  { id: "M7-PW-PHRASE-CUT", what: "the passphrase reading reads on past the keyword of another rule or a second password word and swallows it", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  const cut = phrase.search(ANY_KEYWORD);", to: "  const cut = -1;", tests: ["mask-tests.js"] },
  { id: "M7-PW-PHRASE-RESCAN", what: "after a phrase that is not a passphrase, the next password word inside it is not read (the scan resumes after the whole match)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    if (end < 0) { PW_PHRASE_RE.lastIndex = keywordEnd; continue; }", to: "    if (end < 0) continue;", tests: ["mask-tests.js"] },
  { id: "M7-PW-NO-LIST", what: "only the first of several passwords in a row is masked (third reading)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    at = passwordListEnd(s, start + v.core.length);", to: "    at = start + v.core.length;", tests: ["mask-tests.js"] },
  { id: "M7-PW-NO-LIST-FILLER", what: "only the first of several passwords in a row is masked (filler-word reading)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "    return { start: val.index, end: passwordListEnd(s, val.index + v.core.length) };", to: "    return { start: val.index, end: val.index + v.core.length };", tests: ["mask-tests.js"] },
  { id: "M7-PW-LIST-WORDS", what: "a plain word after the list separator is masked too ('password: Hunter22, call Maria')", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "|| v.keyword || !v.secretLooking || !/\\p{L}/u.test(v.core) || PW_EMAIL.test(v.core)) break;", to: "|| v.keyword || PW_EMAIL.test(v.core)) break;", tests: ["mask-tests.js"] },
  { id: "M7-PW-LIST-NUMBERS", what: "a pure number after the list separator is masked too ('password: Hunter22, 951-555-0142')", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "|| !v.secretLooking || !/\\p{L}/u.test(v.core) ||", to: "|| !v.secretLooking ||", tests: ["mask-tests.js"] },
  { id: "M7-PW-LIST-UNBOUNDED", what: "a list of passwords is masked without a limit of three more", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  for (let k = 0; k < 3; k++) {\n    PW_NEXT.lastIndex = pos;", to: "  for (let k = 0; k < 300; k++) {\n    PW_NEXT.lastIndex = pos;", tests: ["mask-tests.js"] },
  { id: "M7-PW-TO-DIRECT", what: "a password straight after 'to' (no filler word) is not read", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "  for (let k = 0; k <= 6; k++) {\n    if (k > 0) {", to: "  for (let k = 1; k <= 6; k++) {\n    if (k > 0) {", tests: ["mask-tests.js"] },
  { id: "M7-PW-WEAK-TO-ONLY", what: "only 'to' is a weak connector ('password will be X', 'password now X' and 'password set as X' are not read)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "(\\\\s+(?:to|be|as|now)${KW_END}\\\\s{1,3})", to: "(\\\\s+(?:to)${KW_END}\\\\s{1,3})", tests: ["mask-tests.js"] },
  { id: "M7-STOP-COMPLETE", what: "'complete' is not an everyday word ('Password reset is complete' is blanked)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "requested completed complete resolved", to: "requested completed resolved", tests: ["mask-tests.js"] },
  { id: "M7-IBAN-RUNS-ON", what: "an IBAN value may run on over a second 'iban' keyword (the second IBAN of 'iban X and iban Y' is left visible)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "(?: ?(?!iban(?![A-Za-z0-9]))[A-Za-z0-9]){10,30}", to: "(?: ?[A-Za-z0-9]){10,30}", tests: ["mask-tests.js"] },
  { id: "M7-SWIFT-PW-WORD", what: "a password word typed in capitals after 'SWIFT' is taken as the code (and its value is left)", file: "approval-briefing/lib/work-order-text-clean.js",
    from: "(!SWIFT_NOT_A_CODE.test(code) && (/\\p{Nd}/u.test(code) || code === code.toUpperCase()) ? head + MASK_TEXT : m)", to: "((/\\p{Nd}/u.test(code) || code === code.toUpperCase()) ? head + MASK_TEXT : m)", tests: ["mask-tests.js"] },
];

function copyTree(destRoot) {
  const keep = (src) => !src.split(path.sep).includes('node_modules');
  const rel = (p) => path.join(destRoot, path.relative(REPO, p));
  const pieces = [
    path.join(HUB, 'approval-briefing'), path.join(HUB, 'maintenance-history', 'lib'), path.join(HUB, 'lib'),
  ];
  for (const p of pieces) fs.cpSync(p, rel(p), { recursive: true, filter: keep });
  fs.copyFileSync(path.join(HUB, 'work-order-notes-alert-SPEC.md'), rel(path.join(HUB, 'work-order-notes-alert-SPEC.md')));
  fs.copyFileSync(path.join(REPO, '.env.example'), path.join(destRoot, '.env.example'));
  fs.mkdirSync(path.join(destRoot, 'compliance'), { recursive: true });
  // this feature's own documents, plus any compliance file the feature code points at
  const wanted = new Set(fs.readdirSync(path.join(REPO, 'compliance')).filter((n) => n.startsWith('work-order-note-alerts-')));
  for (const f of ['router.js', 'lib/work-order-notes-alert.js', 'lib/work-order-summary.js']) {
    const src = fs.readFileSync(path.join(HUB, 'approval-briefing', f), 'utf8');
    for (const m of src.matchAll(/compliance\/([a-z0-9-]+\.md)/g)) wanted.add(m[1]);
  }
  for (const f of wanted) fs.copyFileSync(path.join(REPO, 'compliance', f), path.join(destRoot, 'compliance', f));
  fs.symlinkSync(path.join(HUB, 'node_modules'), path.join(destRoot, 'projects', 'hub', 'node_modules'));
}

function runTest(root, file) {
  const res = spawnSync(process.execPath, [path.join(root, 'projects/hub/approval-briefing/test', file)], {
    encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: '/tmp/x', SUPABASE_URL: 'https://placeholder.invalid', SUPABASE_SERVICE_ROLE_KEY: 'placeholder' },
  });
  const out = (res.stdout || '') + (res.stderr || '');
  const m = out.match(/(\d+)\/(\d+) passed/);
  const failed = out.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.slice(5, 70));
  return { ok: res.status === 0 && !!m && m[1] === m[2], failed, status: res.status };
}

const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > -1 ? new Set(process.argv[onlyArg + 1].split(',')) : null;

let scratch;
function main() {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wo-mutation-'));
  copyTree(scratch);
  process.stdout.write(`Scratch copy: ${scratch}\n`);

  // 1. the unbroken copy must pass everything, or the experiment means nothing
  for (const f of ['run-tests.js', 'cleaner-tests.js', 'screen-corpus.js', 'no-ai-proof.js', 'fix-round-tests.js', 'round3-tests.js', 'round4-tests.js', 'unscreened-tests.js', 'mask-tests.js']) {
    const r = runTest(scratch, f);
    if (!r.ok) { process.stdout.write(`BASELINE FAILED in the unbroken copy: ${f} ${r.failed.join(' | ')}\n`); process.exitCode = 2; return; }
  }
  process.stdout.write('Baseline: the unbroken copy passes every test file.\n\n');

  let survived = 0; let caught = 0; let skipped = 0;
  for (const mu of MUTANTS) {
    if (only && !only.has(mu.id)) { skipped++; continue; }
    const target = path.join(scratch, 'projects/hub', mu.file);
    const original = fs.readFileSync(target, 'utf8');
    // one edit (from / to) or several (edits: [[from, to], ...]), applied in order to the scratch copy
    const edits = mu.edits || [[mu.from, mu.to]];
    let mutated = original;
    let applied = true;
    for (const [from, to] of edits) {
      if (!mutated.includes(from)) { applied = false; break; }
      mutated = mutated.replace(from, () => to);
    }
    if (!applied) { process.stdout.write(`BAD   ${mu.id}: the mutation did not apply (text not found)\n`); survived++; continue; }
    fs.writeFileSync(target, mutated);
    // noSelfTest: also switch off the screen's start-up self-test, so the test files must catch the break by themselves
    // (otherwise the self-test alone would fail every call closed and "catch" the mutant for us).
    const screenFile = path.join(scratch, 'projects/hub/approval-briefing/lib/work-order-text-screen.js');
    const screenBefore = mu.noSelfTest ? fs.readFileSync(screenFile, 'utf8') : null;
    if (mu.noSelfTest) fs.writeFileSync(screenFile, screenBefore.replace('return { ok: wrong === 0, wrong };', () => 'return { ok: true, wrong: 0 };'));
    let noticedBy = null; let which = [];
    try {
      for (const t of mu.tests) {
        const r = runTest(scratch, t);
        if (!r.ok) { noticedBy = t; which = r.failed; break; }
      }
    } finally {
      if (mu.noSelfTest) fs.writeFileSync(screenFile, screenBefore);
      fs.writeFileSync(target, original);
    }
    if (noticedBy) { caught++; process.stdout.write(`CAUGHT   ${mu.id.padEnd(15)} ${mu.what}${mu.noSelfTest ? ' [self-test switched off]' : ''}\n         by ${noticedBy}: ${which.slice(0, 2).join(' | ')}${which.length > 2 ? ` (+${which.length - 2} more)` : ''}\n`); }
    else { survived++; process.stdout.write(`SURVIVED ${mu.id.padEnd(15)} ${mu.what}  <-- the tests did not notice\n`); }
  }
  process.stdout.write(`\n${caught} mutants caught, ${survived} survived or did not apply${skipped ? `, ${skipped} skipped` : ''}.\n`);
  process.exitCode = survived ? 1 : 0;
}

try { main(); } finally {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
}
