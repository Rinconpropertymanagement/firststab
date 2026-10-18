#!/usr/bin/env node
/**
 * q-regex-speed-test.js
 * Proves that no text a model (or a person typing an address) can produce makes the explanation checks run for long.
 *
 * It builds hostile strings of 50,000 characters (every shape that ever made a pattern slow, plus new ones: repeated
 * "from $1,000 to $2,000", nested punctuation, long capitalized runs after "from", unicode-dash spam, zero-width
 * spam, HTML-entity spam, ALL CAPS, address spam, "carries no weight" repeated, one 50,000-character token, ...) and
 * feeds each one to every function in lib/narrative.js that reads model text, timing each call.
 * Each call must finish in well under a second; the unit test asserts under 500 ms, and the usual time is a few milliseconds.
 *
 * Usage:
 *   node q-regex-speed-test.js             run at 50,000 characters, print the table, exit 1 if any call takes 150 ms or more
 *   node q-regex-speed-test.js --size 7900 use another size (7,900 and 1,900 sit just under the 8,000 / 2,000 character limits)
 *   node q-regex-speed-test.js --limit 500 change the pass mark in milliseconds
 *   node q-regex-speed-test.js --help
 * Nothing leaves this computer and nothing is saved.
 */
'use strict';

const N = require('./lib/narrative');

const repeat = (s, n) => s.repeat(Math.ceil(n / s.length)).slice(0, n);

function hostileStrings(size = 50000) {
  const n = size;
  return {
    'from A A A': 'from ' + repeat('A ', n),
    'between a a a': 'between ' + repeat('a ', n),
    'a-a-a-': repeat('a-', n),
    'and and and': repeat('and ', n),
    'three hundred and': repeat('three hundred and ', n),
    'hundred hundred': repeat('hundred ', n),
    '1 1 1 1': repeat('1 ', n),
    '1-1-1-': repeat('1-', n),
    'spaces then $1': ' '.repeat(n) + '$1',
    '$1,000 to $': repeat('$1,000 to $', n),
    'from $1,000 to $2,000 repeated': repeat('from $1,000 to $2,000 ', n),
    'nested ((((': repeat('(', n),
    'nested [[[[': repeat('[', n),
    'nested punctuation': repeat('(.,;[(', n),
    'capitalized words after from': 'from $1 ' + repeat('Abc ', n) + '$2',
    'capitalized words, no dollar sign': 'from ' + repeat('Abc ', n) + 'to $2',
    'capitalized words around two figures': 'from ' + repeat('Abc ', n / 2) + '$1 to ' + repeat('Abc ', n / 2) + '$2',
    'unicode dash between figures': '$1' + repeat('‑', n) + '$2',
    'unicode dash spam': repeat('–', n),
    'zero-width spam': repeat('​', n),
    'zero-width inside "to"': repeat('t​o ', n),
    'HTML entity spam (ndash)': repeat('&ndash;', n),
    'HTML entity spam (nbsp)': repeat('&nbsp;', n),
    'ALL CAPS': repeat('ABCD ', n),
    'FROM $1 TO $2': repeat('FROM $1 TO $2 ', n),
    'address spam': repeat('123 Main St ', n),
    'address spam, two streets': repeat('1 A St 2 B St ', n),
    'house numbers': repeat('123 ', n),
    'house number lists': repeat('12, 14 and ', n),
    '"carries no weight" repeated': repeat('carries no weight ', n),
    '"carries no weight" with an address': repeat('carries no weight at 123 Main St. ', n),
    'one 50,000-character token (letters)': 'A'.repeat(n),
    'one token of 1s': '1'.repeat(n),
    'one token $1111': '$' + '1'.repeat(n),
    'comp labels': repeat('comps 1, 2, 3 and 4 comp 5 ', n),
    '"leased" repeated': repeat('leased ', n),
    'full stops': repeat('. ', n),
    'em dashes with spaces': repeat(' — ', n),
    'dollar signs': repeat('$ ', n),
    '$1k-$1k-': repeat('$1k-', n),
    'lowest/highest sentences': repeat('The lowest is $3,200 and the highest is $4,600. ', n),
    'lowest highest words': repeat('lowest highest ', n),
    'figures and dashes': repeat('1,000-', n),
    'figures with spaced dashes': repeat('1,000 - ', n),
    '$1 then "to" spam': '$1 ' + repeat('to ', n) + '$2',
    '"up to" spam': repeat('up to ', n),
    'marker then braces': 'RENTAL_ANALYSIS_OUTPUT: {' + repeat('}', n),
    'marker then spaces then x': 'RENTAL_ANALYSIS_OUTPUT: {"rationale": "x"}' + ' '.repeat(n) + 'x',
    'escaped quotes in a JSON string': 'RENTAL_ANALYSIS_OUTPUT: {"rationale": "' + repeat('\\"', n),
    'repeated markers': repeat('RENTAL_ANALYSIS_OUTPUT: {x} ', n),
    '"comp" then spaces': 'comp' + ' '.repeat(n) + '1',
    '$1, spaces, "to", spaces, 2': '$1' + ' '.repeat(n) + 'to' + ' '.repeat(n) + '2',
    'figure with thousands of comma groups': '$' + repeat('1,000,', n),
    '450 "$1" then an invented rent': repeat('$1 ', 1350) + 'Rent them at $9,999 a month.',
    'dollar signs only': '$'.repeat(n),
    '"$1 " repeated': repeat('$1 ', n),
    'HTML tags': repeat('<b>', n),
    'unclosed HTML tags': repeat('<a', n),
    'Cyrillic look-alikes': repeat('\u043e\u0430\u0435', n),
    '"$3 200 " repeated': repeat('$3 200 ', n),
    '"$3.200 " repeated': repeat('$3.200 ', n),
    '"3.2 thousand " repeated': repeat('3.2 thousand ', n),
    '"between 3,200 and " repeated': repeat('between 3,200 and ', n),
    '"/mo" and "per month" repeated': repeat('$1/mo per month $1 a month ', n),
    'labelled low/high repeated': repeat('low: $3,200; high: ', n),
    'slash pairs': repeat('$1 / ', n),
    '"days to lease" repeated': repeat('30 days to ', n),
    'source names repeated': repeat('Zillow Redfin Facebook Marketplace ', n),
    '"and so on up to" repeated': repeat('and so on up to ', n),
    'initials and suffixes before units': repeat('121 W. Channel Islands Blvd. Unit 3 St. Apt ', n),
    '"the low end is $3,200 and the high end is $4,600" repeated': repeat('The low end is $3,200 and the high end is $4,600. ', n),
    '"from the low $3,000s to the mid $4,000s" repeated': repeat('from the low $3,000s to the mid $4,000s ', n),
    'many distinct rents': Array.from({ length: 6000 }, (_, i) => `$${3000 + (i % 2500)}`).join(' ').slice(0, n),
    'the same rent repeated': repeat('$3,200 ', n),
    'a distance with no comp named, repeated': repeat('Rents differ by $1,000 depending on the comp. ', n),
    'a distance in many short sentences': repeat('$800. ', n),
    'distances beside unit words': repeat('Unit 1 #2 $1,000 Apt ', n),
    'unit words alone': repeat('Unit ', n),
    'hash marks': repeat('# ', n),
    'a distance, then an address, in every sentence': repeat('$1,000 below. 1556 Bittern Ct. ', n),
    'many JSON entries': 'RENTAL_ANALYSIS_OUTPUT: {"rationale":"x","comp_narratives": {' + repeat('"1": "a", ', n),
  };
}

const SUBJECT = { address: '2292 Buffalo Avenue, Ventura, CA 93003' };
const COMPS = [
  { address: '1556 Bittern Ct, Ventura, CA 93003', monthly_rent: 3200, listing_status: 'leased', exclusion_reason: null, source_name: 'CRMLS' },
  { address: '6630 Sora St, Ventura, CA 93003', monthly_rent: 3400, listing_status: 'active', exclusion_reason: null, source_name: 'RentCast' },
  { address: '2292 Buffalo Avenue, Ventura, CA 93003', monthly_rent: 4600, listing_status: 'leased', exclusion_reason: null, source_name: 'CRMLS' },
  { address: '2300 Buffalo Avenue, Ventura, CA 93003', monthly_rent: 3900, listing_status: 'leased', exclusion_reason: null, source_name: 'CRMLS' },
  { address: '123 Main St, Ventura, CA 93003', monthly_rent: 4400, listing_status: 'active', exclusion_reason: null, source_name: 'RentCast' },
];
const INPUT = { subject: SUBJECT, comps: COMPS, headline: { low: 4200, high: 4400, listPrice: 4350, goal: 'balanced', stretchPrice: 4600 }, subjectEstimatedRent: 4580 };

const CHECK_CONTEXT = N.buildCheckContext(INPUT);

// every function in lib/narrative.js that reads model text (or the writer's raw answer), called the way the pipeline calls it
const FUNCTIONS = {
  'validateRationale': t => N.validateRationale(t, INPUT),
  'findWideRangeStatements (explanation)': t => N.findWideRangeStatements(t, INPUT),
  'findWideRangeStatements (per-comp)': t => N.findWideRangeStatements(t, INPUT, { narrative: true }),
  'guardLeasedClaims': t => N.guardLeasedClaims(COMPS, [t, null, null, null, null]),
  'guardCompLabels': t => N.guardCompLabels(COMPS, [t, null, null, null, null]),
  'guardNoWeightClaims': t => N.guardNoWeightClaims(COMPS, [t, null, null, null, null]),
  'guardWideRanges': t => N.guardWideRanges(COMPS, [t, null, null, null, null], INPUT),
  'findBadAddresses': t => N.findBadAddresses(t, INPUT),
  'findUnanchoredDistances': t => N.findUnanchoredDistances(t, CHECK_CONTEXT),
  'extractAddressMentions': t => N.extractAddressMentions(t),
  'findCompLabels': t => N.findCompLabels(t),
  'findNoWeightClaims': t => N.findNoWeightClaims(t, COMPS, 0),
  'extractDollarFigures': t => N.extractDollarFigures(t),
  'dropFlaggedSentences': t => N.dropFlaggedSentences(t, INPUT),
  'parseNarrativeOutput': t => { try { N.parseNarrativeOutput(t, 5); } catch (e) { /* a refusal is fine; only the time matters */ } },
  'salvagePartialOutput': t => N.salvagePartialOutput(t, 5),
};

/** @returns {{pattern: string, fn: string, ms: number}[]} one row per hostile string and function */
function measureAll(size = 50000) {
  const warn = console.warn;
  console.warn = () => {};   // the guards log one line when they drop a narrative
  const rows = [];
  try {
    for (const [pattern, text] of Object.entries(hostileStrings(size))) {
      for (const [fn, call] of Object.entries(FUNCTIONS)) {
        const start = process.hrtime.bigint();
        call(text);
        rows.push({ pattern, fn, ms: Number(process.hrtime.bigint() - start) / 1e6 });
      }
    }
  } finally {
    console.warn = warn;
  }
  return rows;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(`q-regex-speed-test.js: feeds hostile strings to every explanation check and times each call.
  --size N    characters per string (default 50000; 7900 and 1900 sit just under the 8,000 / 2,000 limits)
  --limit MS  pass mark per call in milliseconds (default 150)
Exits 0 when every call is under the limit, 1 otherwise.`);
    return 0;
  }
  const arg = name => { const i = args.indexOf(name); return i === -1 ? null : Number(args[i + 1]); };
  const size = arg('--size') || 50000;
  const limit = arg('--limit') || 150;
  const rows = measureAll(size);
  const byFn = {};
  for (const r of rows) byFn[r.fn] = Math.max(byFn[r.fn] || 0, r.ms);
  console.log(`Hostile strings of ${size.toLocaleString('en-US')} characters: ${Object.keys(hostileStrings(10)).length} patterns x ${Object.keys(FUNCTIONS).length} functions = ${rows.length} calls`);
  console.log('Slowest call per function (ms):');
  for (const [fn, ms] of Object.entries(byFn)) console.log(`  ${ms.toFixed(1).padStart(7)}  ${fn}`);
  const slow = rows.filter(r => r.ms >= limit);
  const top = [...rows].sort((a, b) => b.ms - a.ms)[0];
  console.log(`Slowest of all: ${top.ms.toFixed(1)} ms (${top.fn} on "${top.pattern}"). Calls at or over ${limit} ms: ${slow.length}.`);
  for (const r of slow) console.log(`  SLOW ${r.ms.toFixed(0)} ms  ${r.fn}  on "${r.pattern}"`);
  return slow.length ? 1 : 0;
}

if (require.main === module) process.exit(main());
module.exports = { hostileStrings, measureAll, FUNCTIONS, INPUT };
