#!/usr/bin/env node
/**
 * diagnose-sales-classification.js
 * Answers "why did this call classify as sales?" at an operator's terminal,
 * on demand, and PERSISTS NOTHING.
 *
 * ============================================================
 * WHY THIS SCRIPT EXISTS AT ALL
 * ============================================================
 * SALES-VS-OPERATIONAL-CLASSIFICATION-SPEC.md Design Decision 23 keeps
 * every outside person's phone number, name and HubSpot contact ID out of
 * Supabase — only three integers per row are stored. That is the whole
 * governance answer for this build, and it is a property of the CODE, not
 * a policy.
 *
 * It has a real cost, named rather than glossed: there is no stored trail
 * of WHICH contact justified any classification, so a disputed number
 * cannot be traced after the fact from the database. THIS SCRIPT IS THE
 * MITIGATION. It reads the same live data the nightly sync reads, prints
 * the Design Decision 19 precedence cascade to a terminal, and writes
 * nothing anywhere — no file, no table, no log.
 *
 * *** IF YOU ARE TEMPTED TO ADD A matched_contact_id COLUMN SO THIS IS
 * QUERYABLE: that is the change Design Decision 23 exists to prevent. It
 * would move this build across CLAUDE.md's "stores someone's personal
 * information" line and require Asimov's review. Use this script. ***
 *
 * Read-only against both Aircall and HubSpot, like everything in this
 * tool. Never writes to either, ever.
 *
 * Usage:
 *   node diagnose-sales-classification.js --date=2026-09-11
 *   node diagnose-sales-classification.js --number="+1 805-288-1119"
 *   node diagnose-sales-classification.js --date=2026-09-11 --durations
 *   node diagnose-sales-classification.js --help
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') });

const aircall = require('./lib/aircall-connector');
const hubspot = require('./lib/hubspot-connector');
const { phoneKey, buildOwnNumberKeySet } = require('./lib/phone-key');
const { collectOutsideNumberKeys } = require('./lib/sync');
const { pacificDayBoundsUnix, yesterdayPacificDateStr } = require('./lib/timezone');
const {
  PROSPECT_LIFECYCLE_STAGES,
  PROSPECT_STAGE_PRECEDENCE,
  CONVERSATION_MIN_TALK_SECONDS,
} = require('./lib/sales-classification-config');

function parseArgs(argv) {
  const args = { date: null, number: null, durations: false, help: false };
  for (const a of argv.slice(2)) {
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--durations') args.durations = true;
    else if (a.startsWith('--date=')) args.date = a.slice(7);
    else if (a.startsWith('--number=')) args.number = a.slice(9);
    else {
      console.error(`Unrecognized argument: ${a}\nRun with --help.`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
diagnose-sales-classification.js
  Explains how the Call Stats sales-vs-operational classification decided a
  given day, or a given phone number. Read-only against Aircall and HubSpot.
  Writes nothing — no file, no database row, no log.

OPTIONS
  --date=YYYY-MM-DD   Explain one Pacific day's calls. Defaults to yesterday.
  --number="..."      Explain ONE phone number. Any format; it is normalized.
                      Skips Aircall entirely — HubSpot lookup only.
  --durations         Also print the talk-time distribution of connected
                      outbound calls to prospect-matched numbers, which is
                      the evidence behind CONVERSATION_MIN_TALK_SECONDS in
                      lib/sales-classification-config.js.
  --help, -h          This text.

WHAT IT PRINTS
  For each matched number: every HubSpot contact holding it, whether that
  contact qualifies, and which record "wins" the Design Decision 19
  precedence cascade. The cascade NEVER changes the answer — the rule is
  "does ANY matching contact qualify," which is order-independent. It only
  names the record that justifies the answer, for troubleshooting.

  It also flags SWITCHBOARD numbers — one number carrying many contacts
  behind extensions, where one qualifying contact makes every call to the
  whole switchboard read as sales. One number in Rincon's HubSpot carries
  58 contacts, three at 'opportunity' — but Rincon did not call it once in
  13 weeks, so the measured impact today is zero. This check exists so that
  if that ever changes it is visible here rather than silently inflating a
  scorecard number.
`);
}

// Design Decision 19's cascade. Returns the record that JUSTIFIES the
// answer. It cannot change the answer — every qualifying record produces
// the same classification — so this is a reporting device only.
function citedRecord(qualifyingContacts) {
  const rank = c => {
    const i = PROSPECT_STAGE_PRECEDENCE.indexOf(c.lifecyclestage);
    return i === -1 ? PROSPECT_STAGE_PRECEDENCE.length : i;
  };
  return [...qualifyingContacts].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    // Tie -> the contact carrying a deal.
    const da = Number(a.num_associated_deals || 0) > 0 ? 0 : 1;
    const db = Number(b.num_associated_deals || 0) > 0 ? 0 : 1;
    if (da !== db) return da - db;
    // Tie -> EARLIEST createdate. Deliberately not most-recently-modified:
    // the Aircall exhaust integration keeps touching records, so
    // hs_lastmodifieddate moves on its own and would make the cited record
    // change between two runs that produced an identical classification.
    const ca = String(a.createdate || '');
    const cb = String(b.createdate || '');
    if (ca !== cb) return ca < cb ? -1 : 1;
    // Absolute floor, so the cascade can never depend on the order HubSpot
    // happened to return results in.
    return Number(a.hs_object_id) - Number(b.hs_object_id);
  })[0];
}

function describeContact(c) {
  const name = `${c.firstname || ''} ${c.lastname || ''}`.trim() || '(no name)';
  const stage = c.lifecyclestage || '(no stage)';
  const prospect = PROSPECT_LIFECYCLE_STAGES.includes(c.lifecyclestage);
  const deals = Number(c.num_associated_deals || 0);
  const why = [prospect ? `prospect stage ${stage}` : null, deals > 0 ? `${deals} deal(s)` : null]
    .filter(Boolean).join(' + ');
  return `id=${c.hs_object_id} "${name}" stage=${stage} deals=${deals}` + (why ? `  <= QUALIFIES: ${why}` : '');
}

async function explainNumbers(keys, { verbose }) {
  const contacts = await hubspot.searchContactsByPhoneKeys(keys);
  const byKey = new Map(keys.map(k => [k, []]));
  for (const c of contacts) {
    for (const k of c.phone_keys) {
      if (byKey.has(k)) byKey.get(k).push(c);
    }
  }

  const qualifyingKeys = new Set();
  const switchboards = [];
  for (const [key, list] of byKey) {
    const qualifying = list.filter(hubspot.contactQualifies);
    if (qualifying.length > 0) qualifyingKeys.add(key);
    // A number carrying many contacts is a main switchboard with
    // extensions, not a person. See lib/phone-key.js's SWITCHBOARD TRAP.
    if (list.length >= 5) {
      switchboards.push({ key, total: list.length, qualifying: qualifying.length });
    }
    if (verbose && list.length > 0) {
      console.log(`\n  ${key}  ->  ${qualifying.length > 0 ? 'SALES' : 'not matched'}  (${list.length} contact(s) hold this number)`);
      for (const c of list) console.log(`      ${describeContact(c)}`);
      if (qualifying.length > 0) {
        console.log(`      CITED (Design Decision 19 cascade): ${describeContact(citedRecord(qualifying))}`);
      }
    }
  }
  return { qualifyingKeys, byKey, switchboards };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return printHelp();

  // ── Single-number mode: no Aircall call at all ──────────────────────────
  if (args.number) {
    const key = phoneKey(args.number);
    if (!key) {
      console.log(`\n"${args.number}" produces NO canonical key.`);
      console.log('A call from this number classifies as UNKNOWN — never as "not matched."');
      console.log('Causes: withheld caller ID, a non-NANP international number, or malformed digits.');
      console.log('See lib/phone-key.js for why international numbers are Unknown rather than given a key that cannot match.\n');
      return;
    }
    console.log(`\n"${args.number}"  ->  canonical key ${key}\n`);
    const ownDigits = await aircall.listOwnLineDigits();
    if (buildOwnNumberKeySet(ownDigits).has(key)) {
      console.log('*** This is one of RINCON\'S OWN line numbers. ***');
      console.log('It is excluded before any HubSpot lookup, and calls on it count as "not matched."');
      console.log('That exclusion is load-bearing: two HubSpot contacts currently hold Rincon\'s');
      console.log('"Property Manager - Faria" line at `opportunity` stage, so without it every');
      console.log('internal call on that line would be counted as an outbound sales call.\n');
      return;
    }
    const { qualifyingKeys } = await explainNumbers([key], { verbose: true });
    console.log(`\n  VERDICT: ${qualifyingKeys.has(key) ? 'SALES' : 'NOT MATCHED'}\n`);
    return;
  }

  // ── Day mode ────────────────────────────────────────────────────────────
  const dateStr = args.date || yesterdayPacificDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    console.error('--date must be YYYY-MM-DD.');
    process.exit(2);
  }
  const { from, to } = pacificDayBoundsUnix(dateStr);
  console.log(`\nPacific day ${dateStr} (unix ${from}-${to})\n${'='.repeat(70)}`);

  const calls = await aircall.listCallsForDateRange(from, to);
  const ownNumberKeys = buildOwnNumberKeySet(await aircall.listOwnLineDigits());
  const { keys, stats } = collectOutsideNumberKeys(calls, ownNumberKeys);

  console.log(`calls fetched                 ${stats.calls_seen}`);
  console.log(`  with a usable number        ${stats.calls_with_usable_key}`);
  console.log(`  NO usable number (UNKNOWN)  ${stats.calls_without_usable_key}`);
  console.log(`  on one of Rincon's own lines${String(stats.calls_on_own_line).padStart(4)}  (excluded before lookup)`);
  console.log(`distinct numbers to look up   ${stats.distinct_keys_to_look_up}  -> ${Math.ceil(stats.distinct_keys_to_look_up / 100)} HubSpot request(s)`);

  console.log(`\nPer-number detail:`);
  const { qualifyingKeys, switchboards } = await explainNumbers(keys, { verbose: true });

  // Re-classify the calls for the totals, using the exact same rule the
  // sync uses.
  let sales = 0, unmatched = 0, unknown = 0, conversations = 0;
  const talkTimes = [];
  for (const call of calls) {
    const key = phoneKey(call.raw_digits);
    if (!key) { unknown++; continue; }
    if (ownNumberKeys.has(key)) { unmatched++; continue; }
    if (qualifyingKeys.has(key)) {
      sales++;
      if (call.direction === 'outbound' && call.answered_at != null && call.ended_at != null) {
        const talk = call.ended_at - call.answered_at;
        talkTimes.push(talk);
        if (talk >= CONVERSATION_MIN_TALK_SECONDS) conversations++;
      }
    } else unmatched++;
  }

  console.log(`\n${'='.repeat(70)}\nTOTALS for ${dateStr}`);
  console.log(`  SALES        ${String(sales).padStart(5)}`);
  console.log(`  Not matched  ${String(unmatched).padStart(5)}   <- Peter reads this as "operational". It is NOT`);
  console.log(`                        labelled that: it also contains prospects nobody`);
  console.log(`                        advanced in HubSpot. Sales is a floor, not a total.`);
  console.log(`  Unknown      ${String(unknown).padStart(5)}`);
  console.log(`  ---------------------`);
  console.log(`  sum          ${String(sales + unmatched + unknown).padStart(5)}  (must equal calls fetched: ${calls.length})`);
  console.log(`  conversations${String(conversations).padStart(5)}  (outbound, connected, >= ${CONVERSATION_MIN_TALK_SECONDS}s talk)`);

  if (switchboards.length > 0) {
    console.log(`\n*** SWITCHBOARD WARNING — numbers carrying many contacts ***`);
    console.log(`These are main lines with extensions. The classification cannot tell which`);
    console.log(`person behind the extension was on the call, so ONE qualifying contact makes`);
    console.log(`EVERY call to the switchboard read as sales. See lib/phone-key.js.`);
    for (const s of switchboards) {
      console.log(`  ${s.key}: ${s.total} contacts, ${s.qualifying} qualifying -> ${s.qualifying > 0 ? 'ALL calls to this number count as SALES' : 'none qualify'}`);
    }
  }

  if (args.durations && talkTimes.length > 0) {
    talkTimes.sort((a, b) => a - b);
    const pct = p => talkTimes[Math.min(talkTimes.length - 1, Math.floor(talkTimes.length * p))];
    console.log(`\nTalk-time distribution, connected outbound calls to prospect-matched numbers (n=${talkTimes.length}):`);
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) console.log(`  p${String(p * 100).padStart(2)}  ${pct(p)}s`);
    for (const t of [10, 30, 60, 90, 120, 180]) {
      const n = talkTimes.filter(x => x >= t).length;
      console.log(`  >= ${String(t).padStart(3)}s : ${String(n).padStart(4)}  (${(100 * n / talkTimes.length).toFixed(1)}%)`);
    }
  }
  console.log('');
}

main().catch(err => {
  console.error('\nFAILED:', err.message, '\n');
  process.exit(1);
});
