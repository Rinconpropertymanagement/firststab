/**
 * lib/fair-housing-filter.js
 *
 * Fair Housing / protected-class content containment for the future
 * shared-inbox email intake. Reuses the actual keyword list and detect-
 * and-flag pattern already built and proven for maintenance-history
 * (../../maintenance-history/lib/protected-class-terms.js) rather than
 * inventing a second list to maintain — Mason only has to keep one term
 * list current across both tools.
 *
 * STATUS: standalone, inert module — see the note at the top of
 * privilege-filter.js. This file never suppresses or deletes anything; it
 * detects and tags, same as maintenance-history's content-check.js, and
 * exposes isSafeForDecisionView() as the function any future
 * decision-adjacent feature (owner reports, applicant/tenant scoring,
 * anything consequential) must check before ever surfacing flagged
 * content — modeling the "wall off" concept the real system would enforce.
 */

const { scanText, TERMS_VERSION } = require('../../maintenance-history/lib/protected-class-terms');

/**
 * Scans a single message's subject + body for protected-class-indicator
 * language. Does not suppress or alter the message — flags it.
 * @returns {{ messageId: string, flagged: boolean, categories: string[] }}
 */
function scanMessage(message) {
  const text = `${message.subject || ''}\n${message.body || ''}`;
  const result = scanText(text);
  return { messageId: message.messageId || null, flagged: result.flagged, categories: result.categories };
}

/**
 * Scans every message in a thread. A thread is flagged if ANY message is
 * flagged — same "don't silently pass mixed content through as routine"
 * principle as the privilege filter's default-deny, applied here to
 * tagging rather than holding (content is still visible, just tagged).
 * @returns {{
 *   threadId: string,
 *   flagged: boolean,
 *   categories: string[],
 *   perMessage: Array<{ messageId, flagged, categories }>,
 *   terms_version: string,
 * }}
 */
function scanThread(thread) {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const perMessage = messages.map(scanMessage);
  const flagged = perMessage.some((m) => m.flagged);
  const categories = Array.from(new Set(perMessage.flatMap((m) => m.categories)));

  return { threadId: thread.threadId || null, flagged, categories, perMessage, terms_version: TERMS_VERSION };
}

/**
 * The "wall off from decision-adjacent view" check. Any future feature
 * that summarizes, scores, or reasons across email content in a way that
 * could touch a housing decision must call this first and skip flagged
 * threads — mirrors maintenance-history's maintenance_claims_decision_safe
 * view (SQL WHERE clause there; a function here, since there's no
 * database table of email threads yet).
 * @param {{ flagged: boolean }} threadScanResult - output of scanThread()
 * @returns {boolean} true if this thread is safe to surface in a
 *   decision-adjacent view; false if it must stay walled off.
 */
function isSafeForDecisionView(threadScanResult) {
  return threadScanResult.flagged !== true;
}

module.exports = { scanMessage, scanThread, isSafeForDecisionView, TERMS_VERSION };
