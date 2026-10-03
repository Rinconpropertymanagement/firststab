/**
 * archive-search/lib/name-match-backfill-lock.js
 * Cross-process lock for the retroactive name-match backfill batch tool —
 * a near-verbatim copy of lib/severity-lock.js's own design (which is
 * itself a near-verbatim copy of lib/significance-lock.js's own design —
 * see that file's own header for the full reasoning: plain lock file not a
 * DB row, single-host pipeline, no migration needed, fails safe on reboot,
 * stale-lock reclaim via a pid liveness probe. Identical here, not
 * re-derived.
 *
 * ============================================================================
 * ITS OWN SEPARATE LOCK FILE, NOT SHARED WITH severity-lock.js — WORKED
 * THROUGH, NOT ASSUMED
 * ============================================================================
 * The build task explicitly flagged this as a real question to think
 * through: these two tools — this one, and lib/severity-batch.js's
 * retroactive severity-tier backfill — both read and write `complaints`
 * rows, and both can plausibly target the SAME row (a complaint can
 * simultaneously be needs_matching=TRUE and severity_tier IS NULL — nothing
 * about one excludes the other). So: could they actually corrupt each
 * other's work if run at the same time?
 *
 * Checked directly, not assumed: the two tools write entirely DISJOINT
 * column sets on `complaints` —
 *   - severity-batch.js's applyOneSeverityResult() writes severity_tier,
 *     severity_rationale, severity_assessed_at, severity_rubric_version.
 *   - this tool's applyOneNameMatchResult() writes suggested_subject_type/
 *     _name_text/_candidate_ids/_extracted_by/_at and
 *     retroactive_name_match_checked_at.
 * Postgres's UPDATE only ever touches the columns a statement actually
 * names — it never resets or overwrites a column the statement doesn't
 * mention. Two concurrent UPDATEs against the same row, naming disjoint
 * column sets, are serialized by Postgres's own row-level locking (one
 * waits for the other's lock to release) and the row ends up with BOTH
 * sets of changes applied correctly, regardless of which one ran first.
 * Each tool also independently re-fetches its own relevant columns fresh
 * at write-back time and applies its own idempotency guard
 * (`.is('severity_tier', null)` / `.is('retroactive_name_match_checked_at',
 * null)`) before writing — neither tool's write depends on, or can be
 * corrupted by, a concurrent write to the OTHER tool's columns on the same
 * row. There is no real correctness reason for these two jobs to serialize
 * against one another — only against THEMSELVES (two copies of the SAME
 * tool's CLI started at once), exactly the distinction severity-lock.js's
 * own header already draws for why IT doesn't share significance-lock.js's
 * lock. A shared lock here would only add unnecessary serialization
 * between two independent, non-colliding jobs — a dedicated lock, scoped to
 * this tool alone, is both simpler and sufficient.
 *
 * (The one shared invariant that DOES span both tools —
 * complaints_held_excludes_ai_fields, which forces severity_tier,
 * suggested_subject_type, AND retroactive_name_match_checked_at all NULL
 * together on a held row — is not a concurrency hazard between the two
 * tools either: each tool already re-checks held_legal_fair_housing fresh
 * at write-back time and skips entirely rather than writing, independent
 * of whatever the other tool is doing.)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCK_PATH = process.env.ARCHIVE_SEARCH_NAME_MATCH_BACKFILL_LOCK_PATH
  || path.join(os.tmpdir(), 'archive-search-name-match-backfill-batch.lock');

class NameMatchBackfillLockedError extends Error {
  constructor(existingLock) {
    super(
      `The name-match backfill tool is already running elsewhere (held by pid ${existingLock.pid} on ` +
      `${existingLock.hostname}, owner "${existingLock.ownerLabel}", acquired ${existingLock.acquiredAt}). ` +
      `Wait for it to finish, or confirm that process is really still alive before doing anything else.`
    );
    this.name = 'NameMatchBackfillLockedError';
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
        throw new NameMatchBackfillLockedError(existing);
      }
      try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* already gone — fine */ }
    }
  }
  const existing = readLockFile() || { pid: 'unknown', hostname: 'unknown', ownerLabel: 'unknown', acquiredAt: 'unknown' };
  throw new NameMatchBackfillLockedError(existing);
}

function releaseLock() {
  const existing = readLockFile();
  if (existing && existing.pid === process.pid) {
    try { fs.unlinkSync(LOCK_PATH); } catch (_) { /* already gone — fine */ }
  }
}

async function withNameMatchBackfillLock(ownerLabel, fn) {
  acquireLock(ownerLabel);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

module.exports = { acquireLock, releaseLock, withNameMatchBackfillLock, NameMatchBackfillLockedError, LOCK_PATH };
