/**
 * lib/index.js
 *
 * Convenience entry point: runs one thread through both containment
 * layers (privilege/legal hold + Fair Housing content detection) and
 * returns a single combined result.
 *
 * ============================================================================
 * NOT CONNECTED TO ANY REAL EMAIL SYSTEM. This module, and everything else
 * under projects/hub/email-intake/, is a standalone library of pure
 * functions that operate only on plain JS objects a caller constructs and
 * passes in.
 *
 *   - It is not required by server.js and not mounted as a route.
 *   - It is not registered in any cron/scheduled job.
 *   - It does not read any API key, OAuth token, or credential — none
 *     exist in .env or .env.example for this module, and none should be
 *     added here without a separate, explicit decision.
 *   - It has never been run against a real inbox and cannot reach one —
 *     there is no network call anywhere in this directory.
 *
 * This stays inert until a human explicitly wires a real Missive connection
 * into it later, gated on the separate legal confirmation referenced in
 * this build's task. Until then, it's a proven, ready component sitting
 * on the shelf.
 * ============================================================================
 */

const { checkThread: checkPrivilege } = require('./privilege-filter');
const { scanThread: checkFairHousing, isSafeForDecisionView } = require('./fair-housing-filter');

/**
 * @param {object} thread - { threadId, legalHoldTag, messages: [...] }
 * @returns {{
 *   threadId: string,
 *   held: boolean,               // Tier 3 (Human Only) — a held thread is
 *                                 // never auto-processed by anything
 *                                 // downstream; a person decides.
 *   holdReasons: object[],
 *   fairHousingFlagged: boolean,
 *   fairHousingCategories: string[],
 *   safeForDecisionView: boolean,
 * }}
 */
function processThread(thread) {
  const privilege = checkPrivilege(thread);
  const fairHousing = checkFairHousing(thread);

  return {
    threadId: thread.threadId || null,
    held: privilege.held,
    holdReasons: privilege.holdReasons,
    fairHousingFlagged: fairHousing.flagged,
    fairHousingCategories: fairHousing.categories,
    safeForDecisionView: isSafeForDecisionView(fairHousing),
  };
}

module.exports = { processThread };
