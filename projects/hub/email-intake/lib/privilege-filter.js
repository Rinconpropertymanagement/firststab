/**
 * lib/privilege-filter.js
 *
 * The four-layer privilege/legal-hold filter for Rincon's future
 * shared-inbox email intake, built to Mason's containment design.
 *
 * STATUS: standalone, inert module. Nothing in this file connects to a
 * real inbox, a real mail provider, or any credential — it only operates
 * on plain JS objects ({ threadId, legalHoldTag, messages: [...] }) that
 * a caller hands it. See email-intake/lib/index.js for the note on why
 * this stays disconnected until a human wires it up.
 *
 * Thread/message shape expected:
 *   thread = {
 *     threadId: string,
 *     legalHoldTag: boolean,      // Layer 3 — staff override, see below
 *     messages: [
 *       { messageId, from, to: [...], cc: [...], subject, body, date },
 *       ...
 *     ],
 *   }
 *
 * TWO-TIER OUTCOME, per Mason's final review. The original build was a flat
 * hold/pass binary; it conflated routine regulatory-agency correspondence
 * with actual legal exposure. Now there are two outcomes:
 *
 *   Tier 1 — TAG   : visible in search results, marked with a tag (e.g.
 *                    "regulatory_matter"), processed normally, NOT held.
 *   Tier 2 — HOLD  : exactly the original hold behavior — the whole thread
 *                    is pulled out of normal processing for a human.
 *
 * Layers, in order:
 *   1. Sender/recipient domain check — government domain -> Tier 1,
 *      law-firm domain -> Tier 2 (see government-legal-domains.js).
 *   2. Keyword scan on subject + full body of every message — TAG_TERMS ->
 *      Tier 1, HOLD_TERMS -> Tier 2 (see privilege-keywords.js).
 *   3. Staff "Legal Hold — do not auto-process" override tag on the thread
 *      -> Tier 2. Untouched by this change; a human override, unrelated to
 *      the tier split.
 *   4. Default-deny, now Tier-2-specific: if ANY message trips a Tier 2
 *      signal (layer 1 law-firm domain or layer 2 HOLD_TERMS), or the
 *      thread carries the layer-3 tag, the WHOLE THREAD is held — not just
 *      the one message that tripped it. Tier 2 always wins: a thread that
 *      starts as routine Tier 1 chatter and later has one message trip a
 *      Tier 2 term (e.g. "our attorney advised...") holds in full, not just
 *      that message.
 *
 *      A thread is only TAGGED (Tier 1, not held) when at least one message
 *      trips a Tier 1 signal and NOTHING anywhere in the thread trips
 *      Tier 2 or the layer-3 tag.
 */

const { classifyDomain } = require('./government-legal-domains');
const { scanForTagKeywords, scanForHoldKeywords } = require('./privilege-keywords');

// Tier 1 tag label attached to a thread's `tags` array. Kept as a single
// named constant (rather than a hardcoded string at each call site) so
// Mason/Q only have one place to change it later if the label needs to
// differ from "regulatory_matter".
const REGULATORY_MATTER_TAG = 'regulatory_matter';

function participantsOf(message) {
  const list = [];
  if (message.from) list.push(message.from);
  if (Array.isArray(message.to)) list.push(...message.to);
  if (Array.isArray(message.cc)) list.push(...message.cc);
  if (Array.isArray(message.bcc)) list.push(...message.bcc);
  return list;
}

/**
 * Runs layers 1 and 2 against a single message. Layers 3/4 are thread-level
 * concepts and live in checkThread() below.
 *
 * Every entry in `reasons` carries a `tier` (1 or 2) alongside its `layer`
 * (1 or 2) — tier is what determines tag-vs-hold; layer is just which check
 * produced it.
 *
 * @returns {{
 *   messageId: string,
 *   tier: 0|1|2,     // highest tier this message alone tripped (0 = none)
 *   held: boolean,   // tier === 2
 *   tagged: boolean, // tier === 1
 *   reasons: object[],
 * }}
 */
function checkMessage(message) {
  const reasons = [];

  // Layer 1 — sender/recipient domain check
  for (const address of participantsOf(message)) {
    const hit = classifyDomain(address);
    if (hit) {
      if (hit.type === 'government') {
        reasons.push({ layer: 1, tier: 1, type: 'government_domain', participant: address, domain: hit.domain });
      } else {
        reasons.push({ layer: 1, tier: 2, type: 'law_firm_domain', participant: address, domain: hit.domain });
      }
    }
  }

  // Layer 2 — keyword scan on subject AND full body, Tier 1 and Tier 2
  // term lists checked independently (a message can trip both).
  const text = `${message.subject || ''}\n${message.body || ''}`;

  const tagHit = scanForTagKeywords(text);
  if (tagHit.matched) {
    reasons.push({ layer: 2, tier: 1, type: 'tag_keyword_match', matchedTerms: tagHit.matchedTerms });
  }

  const holdHit = scanForHoldKeywords(text);
  if (holdHit.matched) {
    reasons.push({ layer: 2, tier: 2, type: 'hold_keyword_match', matchedTerms: holdHit.matchedTerms });
  }

  const tier = reasons.some((r) => r.tier === 2) ? 2 : reasons.length > 0 ? 1 : 0;

  return {
    messageId: message.messageId || null,
    tier,
    held: tier === 2,
    tagged: tier === 1,
    reasons,
  };
}

/**
 * Runs all four layers against a thread.
 *
 * Per Layer 4 (default-deny, now Tier-2-specific): a single message
 * anywhere in the thread tripping a Tier 2 signal holds the ENTIRE
 * thread — this is the actual returned behavior (`held` is a
 * thread-level field), not just a note that it should happen. Tier 2
 * always overrides Tier 1: `tagged` is only ever true when `held` is
 * false.
 *
 * @returns {{
 *   threadId: string,
 *   held: boolean,          // Tier 2 — whole thread pulled for a human
 *   tagged: boolean,        // Tier 1 — tagged, kept in normal processing
 *   tier: 0|1|2,            // thread-level outcome, 2 wins over 1
 *   tags: string[],         // e.g. ['regulatory_matter'] when tagged
 *   holdReasons: object[],  // Tier 2 reasons (layer 3 + layer 4)
 *   tagReasons: object[],   // Tier 1 reasons, only populated when tagged
 *   perMessage: Array<{ messageId, tier, held, tagged, reasons }>,
 * }}
 */
function checkThread(thread) {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const perMessage = messages.map(checkMessage);

  const layer3Tripped = thread.legalHoldTag === true;
  const anyMessageTier2 = perMessage.some((m) => m.tier === 2);
  const anyMessageTier1 = perMessage.some((m) => m.tier >= 1);

  const held = layer3Tripped || anyMessageTier2;
  const tagged = !held && anyMessageTier1;
  const tier = held ? 2 : tagged ? 1 : 0;

  const holdReasons = [];
  if (layer3Tripped) {
    holdReasons.push({ layer: 3, tier: 2, type: 'staff_legal_hold_tag' });
  }
  if (held) {
    for (const m of perMessage) {
      if (m.tier === 2) {
        holdReasons.push({
          layer: 4,
          tier: 2,
          type: 'thread_default_deny',
          triggeredByMessageId: m.messageId,
          reasons: m.reasons.filter((r) => r.tier === 2),
        });
      }
    }
  }

  const tagReasons = [];
  const tags = [];
  if (tagged) {
    tags.push(REGULATORY_MATTER_TAG);
    for (const m of perMessage) {
      if (m.tier === 1) {
        tagReasons.push({
          triggeredByMessageId: m.messageId,
          reasons: m.reasons.filter((r) => r.tier === 1),
        });
      }
    }
  }

  return {
    threadId: thread.threadId || null,
    held,
    tagged,
    tier,
    tags,
    holdReasons,
    tagReasons,
    perMessage,
  };
}

module.exports = { checkMessage, checkThread, REGULATORY_MATTER_TAG };
