/**
 * archive-search/lib/severity-lock.js
 * Cross-process lock for the complaint severity-tier backfill batch tool —
 * a near-verbatim copy of lib/significance-lock.js's own design, kept as its
 * own separate lock file rather than sharing that module's lock, because
 * these are two independent jobs that should never block each other just
 * because they happen to run on the same host (a severity backfill run and
 * a significance pass run touch different tables and have no real
 * correctness reason to serialize against one another — only AGAINST
 * THEMSELVES, i.e. two copies of the severity batch CLI started at once).
 *
 * See significance-lock.js's own header for the full design reasoning
 * (plain lock file not a DB row — Scotty's call, single-host pipeline, no
 * migration needed, fails safe on reboot; stale-lock reclaim via a pid
 * liveness probe) — identical here, not re-derived.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_PATH = process.env.ARCHIVE_SEARCH_SEVERITY_LOCK_PATH
  || path.join(os.tmpdir(), 'archive-search-severity-batch.lock');

class SeverityBatchLockedError extends Error {
  constructor(existingLock) {
    super(
      `The severity batch tool is already running elsewhere (held by pid ${existingLock.pid} on ` +
      `${existingLock.hostname}, owner "${existingLock.ownerLabel}", acquired ${existingLock.acquiredAt}). ` +
      `Wait for it to finish, or confirm that process is really still alive before doing anything else.`
    );
    this.name = 'SeverityBatchLockedError';
    this.existingLock = existingLock;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function readLockFile() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch (err) {
    return null;
  }
}

function acquireLock(ownerLabel) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
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
        throw new SeverityBatchLockedError(existing);
      }
      try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* already gone — fine */ }
    }
  }
  const existing = readLockFile() || { pid: 'unknown', hostname: 'unknown', ownerLabel: 'unknown', acquiredAt: 'unknown' };
  throw new SeverityBatchLockedError(existing);
}

function releaseLock() {
  const existing = readLockFile();
  if (existing && existing.pid === process.pid) {
    try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* already gone — fine */ }
  }
}

async function withSeverityLock(ownerLabel, fn) {
  acquireLock(ownerLabel);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

module.exports = { acquireLock, releaseLock, withSeverityLock, SeverityBatchLockedError, LOCK_PATH };
