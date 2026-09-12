/**
 * lib/phone-key.js
 * One canonical phone key, and an honest account of what fails to produce
 * one. SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md Design Decision 18.
 *
 * Pure string handling — no network, no database, same split from the
 * callers that lib/sync.js and lib/timezone.js already use.
 *
 * ============================================================
 * WHY THE KEY IS TEN BARE DIGITS AND NOT E.164
 * ============================================================
 * Not an aesthetic choice, and not the spec's reasoning either — it is
 * forced by what HubSpot will actually match. LIVE-VERIFIED 2026-09-12
 * against Rincon's real portal, on a contact whose `phone` is stored as
 * "+16614870059":
 *
 *     hs_searchable_calculated_phone_number IN ["6614870059"]   -> 1 hit
 *     hs_searchable_calculated_phone_number IN ["+16614870059"] -> 0 hits
 *     hs_searchable_calculated_phone_number IN ["16614870059"]  -> 0 hits
 *
 * HubSpot stores its own calculated key as bare NANP digits and matches it
 * literally. Ten bare digits is therefore the only shape that works, and a
 * "+1" prefix silently matches NOTHING — which would have looked exactly
 * like "no prospect called today," every night, forever.
 *
 * ============================================================
 * THE INTERNATIONAL CASE — CHANGED FROM THE SPEC, DELIBERATELY
 * ============================================================
 * Design Decision 18 says a non-+1 number should keep its full E.164
 * string as the key and be compared only against other full E.164 strings.
 * On this portal that rule cannot match anything: HubSpot's calculated
 * property does not store E.164 (see above), and a scan of 1,000 real
 * contacts found it holding 10 digits 994 times, with the remainder a
 * handful of 9-, 11-, 20- and 30-digit oddities (two numbers concatenated
 * into one field, an Australian +61 number, and similar).
 *
 * So an international number gets NO KEY here and classifies as UNKNOWN,
 * rather than getting a key that is guaranteed not to match and would
 * therefore be reported as "not matched" — i.e. counted as operational.
 * That is the whole distinction Design Decision 24 exists to protect:
 * UNKNOWN means "we could not find out," and a lookup that cannot
 * possibly succeed is exactly that. Rare in a SoCal portfolio, and the
 * Unknown column on the page is where it becomes visible rather than
 * quietly inflating the operational count.
 *
 * ============================================================
 * WHAT FAILS, LISTED RATHER THAN HAND-WAVED
 * ============================================================
 *   Withheld / anonymous caller ID  -> null key -> UNKNOWN
 *   Non-+1 international            -> null key -> UNKNOWN (see above)
 *   Short code / 7-digit fragment   -> null key -> UNKNOWN. Never
 *                                      area-code-completed, never guessed.
 *   Extension suffix on HubSpot's
 *     side ("(805) 749-2638 ext.
 *     2204")                        -> handled by HubSpot itself, which
 *                                      strips it into the base ten digits.
 *                                      See the SWITCHBOARD warning below.
 *   A HubSpot contact with no phone -> invisible to this rule. Not a
 *                                      matching failure; there is nothing
 *                                      to match.
 *
 * ============================================================
 * *** THE SWITCHBOARD TRAP — WORSE ON REAL DATA THAN THE SPEC ADMITS ***
 * ============================================================
 * Design Decision 18's table calls the extension collapse "acceptable,
 * because the question is 'does ANY qualifying contact hold this number.'"
 * Measured on Rincon's real portal 2026-09-12, one number — 805-749-2638 —
 * carries FIFTY-EIGHT contacts, one per extension behind a single main
 * switchboard: 42 `subscriber`, 3 `customer`, 2 `lead`, 8 unset, and
 * THREE at `opportunity`.
 *
 * Under "any qualifies," every call to or from that switchboard would
 * classify as SALES — including calls to the 42 subscriber and 3 customer
 * contacts behind other extensions. No amount of normalization fixes it:
 * the extension is genuinely absent from the call record, so the tool
 * cannot tell which of the 58 people was on the phone.
 *
 * *** ITS MEASURED IMPACT TODAY IS ZERO, AND THE HONEST VERSION OF THIS
 * WARNING SAYS SO. *** Across 8,925 real calls over 13 weeks
 * (2026-06-08..2026-09-06), Rincon called that switchboard NOT ONCE. Of
 * the 2,013 distinct outside numbers actually dialled or received in that
 * window, exactly one carried 5 or more contacts, and NONE of its contacts
 * qualified. So this is a live mechanism with no current effect — worth
 * knowing about, not worth distorting the design for, and specifically NOT
 * a reason to disbelieve the sales figures this tool currently produces.
 *
 * It is therefore NOT worked around here. A per-number contact-count
 * ceiling was considered and rejected: it would refuse genuinely busy real
 * prospects on a volume heuristic, trading a measured-at-zero error for an
 * unmeasured one. It is instead SURFACED — every run of
 * diagnose-sales-classification.js reports any matched key carrying an
 * outsized number of contacts, so if Rincon ever starts calling a
 * switchboard, it shows up there rather than silently inflating a
 * scorecard number.
 */

/**
 * The canonical key for one phone number, or null if none can be made.
 *
 * @param {string|number|null} raw - any real-world phone string. Aircall's
 *   human-formatted `raw_digits` ("+1 805-288-1119"), an E.164 string, or
 *   HubSpot's own bare digits all reduce to the same key.
 * @returns {string|null} ten bare digits, or null (-> UNKNOWN, never
 *   "not matched")
 */
function phoneKey(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  // Everything else — 0 digits (withheld), 7 (fragment), 11+ not starting
  // with 1 (international), or the concatenated-numbers junk seen live —
  // deliberately produces no key. See the header: no key means UNKNOWN,
  // and UNKNOWN is never folded into "not matched."
  return null;
}

/**
 * Rincon's own line numbers, as keys, for exclusion BEFORE any lookup.
 *
 * *** THIS IS LOAD-BEARING AND IT IS NOT TIDINESS. ***
 * Design Decision 18 argued this defensively — "the exhaust could
 * plausibly have created a contact holding one of Rincon's own numbers,
 * and if it were ever advanced by hand, every internal call would classify
 * as sales." LIVE-VERIFIED 2026-09-12: it already has.
 *
 * Rincon's "Property Manager - Faria" line, +1 805-427-9358, is held in
 * HubSpot by TWO separate contacts sitting at `opportunity` — one named
 * "Marci " and one named " Inspections" — alongside three more records on
 * the same number at `lead`. Fifteen contacts in total hold one of
 * Rincon's fifteen own line numbers.
 *
 * Without this exclusion, every call to or from Property Manager - Faria,
 * one of the busiest lines on the account, would be counted as an outbound
 * sales call, in both directions, every night. The exclusion removes the
 * possibility by construction instead of trusting that nobody ever
 * advanced one of those records — which would have been a wrong bet
 * already, today, before this shipped.
 *
 * @param {Iterable<string>} ownNumberStrings - Rincon's 15 Aircall line
 *   digits, plus every call_stats_hubspot_native_numbers.phone_number.
 *   Read fresh each sync by the caller rather than hardcoded here: lines
 *   get added and retired in Aircall, and a stale literal list in this
 *   file would silently stop excluding a new line.
 * @returns {Set<string>} keys to exclude
 */
function buildOwnNumberKeySet(ownNumberStrings) {
  const keys = new Set();
  for (const n of ownNumberStrings || []) {
    const key = phoneKey(n);
    // A line whose digits don't reduce to a key is skipped rather than
    // throwing: it cannot collide with a caller key either, so it is
    // harmless. The caller counts these so a line list that has gone
    // strange is visible instead of quietly shrinking the exclusion set.
    if (key) keys.add(key);
  }
  return keys;
}

module.exports = { phoneKey, buildOwnNumberKeySet };
