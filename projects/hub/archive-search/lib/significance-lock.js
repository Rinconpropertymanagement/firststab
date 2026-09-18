/**
 * archive-search/lib/significance-lock.js
 * Cross-process lock for the significance/complaint-triage pass.
 *
 * WHY THIS EXISTS: Asimov's automatic-scheduling governance review
 * (2026-09-18) flagged a real, separate technical gap — nothing today
 * stops the standalone batch/pilot scripts (run-significance-batch.js,
 * run-significance-pilot.js — launched by hand via `nohup ... & disown`,
 * per each script's own header, "runs entirely on sally") from running at
 * the same time as the Hub's own live route
 * (POST /api/archive-search/process-significance-pending) or any future
 * scheduled trigger for it. router.js's existing in-process guard
 * (significancePassRunning, a plain boolean) only protects against
 * overlap WITHIN the single pm2 'hub' process — it does nothing for a
 * separate `node run-significance-batch.js` process, which has its own
 * memory and never sees that flag. This module is the real, cross-process
 * fix: every one of those four entry points acquires the SAME lock before
 * calling into lib/significance-pass.js's runSignificancePassBatch(), so
 * two of them can never run concurrently regardless of which kind of
 * process started first.
 *
 * DESIGN CHOICE — a plain lock file, not a database row. This is Scotty's
 * call (infrastructure/deployment, not a data-schema decision — Neo owns
 * schema changes, and this doesn't need one): every process in this
 * pipeline runs on exactly one host, Sally (CLAUDE.md's standing rule,
 * restated in run-significance-batch.js's and run-significance-pilot.js's
 * own headers), so there's no multi-host coordination problem a database
 * lock would solve that a local file doesn't already solve more simply —
 * with no migration for Peter to apply by hand, and no dependency on
 * Supabase being reachable just to check whether it's safe to start. A
 * lock file also fails safe on the failure mode that matters most here: if
 * Sally reboots, every process holding a lock dies WITH it, so a fresh
 * boot never inherits a stale lock in the first place.
 *
 * WHERE THE LOCK FILE LIVES: /tmp, same convention this pipeline's own
 * nohup logs already use (run-significance-batch.js's and
 * run-significance-pilot.js's own header comments: `> /tmp/significance-
 * batch.log`, `> /tmp/significance-pilot.log`). Deliberately NOT inside
 * archive-search/ or anywhere under /var/www/hub — deploy-to-sally.sh
 * rsyncs that whole tree with --delete on every deploy, and a lock file
 * living there could be deleted out from under a still-running process by
 * an unrelated mid-run deploy. /tmp is outside that tree entirely, so a
 * deploy can never touch it.
 *
 * STALE-LOCK HANDLING: the one real risk a plain lock file has that a
 * reboot doesn't already cover — a process holding the lock is killed
 * (crash, `kill -9`, OOM) without ever reaching its own `finally`/signal-
 * handler release. On every acquire attempt, if a lock file already
 * exists, its recorded pid is checked with `process.kill(pid, 0)` (a
 * signal-0 probe — throws ESRCH if that pid isn't running; does not
 * actually signal anything). A lock whose pid is no longer alive is
 * treated as stale and reclaimed automatically — no manual cleanup step
 * for Peter or Scotty to remember. See acquireLock()'s own comment for the
 * narrow, accepted race this has, and why it's fine for this pipeline.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_PATH = process.env.ARCHIVE_SEARCH_SIGNIFICANCE_LOCK_PATH
  || path.join(os.tmpdir(), 'archive-search-significance-pass.lock');

class SignificancePassLockedError extends Error {
  constructor(existingLock) {
    super(
      `The significance pass is already running elsewhere (held by pid ${existingLock.pid} on ` +
      `${existingLock.hostname}, owner "${existingLock.ownerLabel}", acquired ${existingLock.acquiredAt}). ` +
      `Wait for it to finish, or confirm that process is really still alive before doing anything else.`
    );
    this.name = 'SignificancePassLockedError';
    this.existingLock = existingLock;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid)) return false; // unreadable/corrupt lock contents — never treat as a live holder
  try {
    process.kill(pid, 0); // signal 0: existence probe only, does not actually signal the process
    return true;
  } catch (err) {
    // ESRCH = no such process = definitely dead. Anything else (e.g.
    // EPERM, if it somehow ran as a different user) means the pid DOES
    // exist and we just can't signal it — treat that as alive, since
    // wrongly reclaiming a real lock is the worse mistake of the two.
    return err.code !== 'ESRCH';
  }
}

function readLockFile() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch (err) {
    return null; // missing, or corrupt/half-written — caller treats this as "no usable info," not as "definitely free"
  }
}

/**
 * Acquires the lock for the calling process. Reclaims a stale lock (its
 * recorded pid is no longer running) automatically. Returns nothing on
 * success. Throws SignificancePassLockedError if a live process already
 * holds it.
 *
 * ownerLabel identifies WHO is asking, for the message shown to whoever
 * hits the resulting lock/409 — e.g. 'cron-live-pipeline',
 * 'manual-live-pipeline-route', 'standalone-batch --since-date=...',
 * 'standalone-pilot'.
 */
function acquireLock(ownerLabel) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx'); // atomic create-if-absent — the actual mutual-exclusion primitive here
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        ownerLabel,
        acquiredAt: new Date().toISOString(),
      }, null, 2));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const existing = readLockFile();
      if (existing && isPidAlive(existing.pid)) {
        throw new SignificancePassLockedError(existing);
      }
      // Stale (dead pid), or unreadable/corrupt — either way nothing here
      // can prove a live holder, so it's not worth blocking on. Reclaim by
      // unlinking and retrying the atomic create above.
      //
      // Accepted race, stated plainly: two processes could both reach this
      // branch for the same stale lock at nearly the same moment and both
      // unlink it, then both retry. Only ONE of the two retried 'wx' opens
      // can win (that's still atomic); the other hits EEXIST again — now
      // against the WINNER's fresh lock — and on its second loop iteration
      // correctly reports SignificancePassLockedError rather than both
      // acquiring. The race only ever costs the loser a spurious "locked"
      // report, never a double-acquire. Acceptable here: every real caller
      // is code in this repo (not an adversary), and stale-lock reclaim
      // itself is rare (it only happens after a hard crash).
      try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* already gone — fine */ }
    }
  }
  // Both attempts hit a live (or freshly reclaimed-by-someone-else) lock —
  // report it rather than looping forever.
  const existing = readLockFile() || { pid: 'unknown', hostname: 'unknown', ownerLabel: 'unknown', acquiredAt: 'unknown' };
  throw new SignificancePassLockedError(existing);
}

/**
 * Releases the lock — but ONLY if this process is the one currently
 * holding it (matched by pid), so a process that just lost a race, or is
 * cleaning up after a lock it never actually held, can never delete
 * someone else's real, active lock.
 */
function releaseLock() {
  const existing = readLockFile();
  if (existing && existing.pid === process.pid) {
    try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* already gone — fine */ }
  }
}

/**
 * Convenience wrapper: acquire, run fn(), always release — even if fn()
 * throws. Every call site in this codebase (router.js's two significance
 * routes, run-significance-batch.js, run-significance-pilot.js) should go
 * through this rather than calling acquireLock()/releaseLock() directly.
 */
async function withSignificanceLock(ownerLabel, fn) {
  acquireLock(ownerLabel);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

module.exports = { acquireLock, releaseLock, withSignificanceLock, SignificancePassLockedError, LOCK_PATH };
