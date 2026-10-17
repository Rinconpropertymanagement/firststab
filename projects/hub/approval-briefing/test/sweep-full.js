#!/usr/bin/env node
/**
 * test/sweep-full.js
 *
 * The exhaustive separator sweep (R4-1). NOT part of run-all.js (it takes a few
 * minutes); round4-tests.js runs a smaller version of the same sweep on every
 * run. Counts only: it prints numbers, never a phrase or a code point list
 * beyond the first few that slipped.
 *
 * What it does: takes EVERY punctuation, symbol and space code point of the
 * Basic Multilingual Plane and the astral planes (the Unicode general
 * categories P*, S* and Z*, assigned code points only) and writes it where the
 * space belongs in every multi-word phrase of the shared Fair Housing list
 * (and, with --local, every multi-word phrase of the feature-local lists, stems
 * written out). Each variant goes through the real path (the cleaner with all
 * its readings, then the screen with all of them) and must be HELD, or be
 * hidden by the link rule (the cleaner replaced it with "[link removed]", so
 * the phrase is never shown).
 *
 * EXCLUDED, by design: a circled, parenthesised or squared single letter
 * (NFKC turns it into one letter, with or without brackets): it IS a letter,
 * and other readings must keep catching words spelled with such letters. The
 * number of excluded code points is printed.
 *
 *   node projects/hub/approval-briefing/test/sweep-full.js [--local] [--limit N]
 *
 * Exit code 1 if anything slipped. No network, no model, no real data.
 */

'use strict';

global.fetch = () => { throw new Error('network is not allowed in this script'); };
const path = require('path');
const LIB = path.resolve(__dirname, '../lib');
const clean = require(path.join(LIB, 'work-order-text-clean.js'));
const screen = require(path.join(LIB, 'work-order-text-screen.js'));
const T = require(path.join(LIB, 'work-order-text-screen-terms.js'));
const shared = require(path.resolve(__dirname, '../../maintenance-history/lib/protected-class-terms.js'));

const withLocal = process.argv.includes('--local');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;

const phrases = [];
for (const list of Object.values(shared.CATEGORIES)) for (const t of list) { const x = t.trim(); if (x.includes(' ')) phrases.push(x); }
phrases.push('section 8');
const sharedCount = phrases.length;
if (withLocal) {
  for (const entries of Object.values(T.TERMS)) {
    for (const { term } of entries) if (term.includes(' ')) phrases.push(term.replace(/\*/g, 's'));
  }
}

const ctx = (s) => `please check the kitchen sink in the unit, ${s}, thanks`;
function heldOrHidden(text) {
  const d = clean.cleanTextBoth(text);
  if (d.ambiguousLink || d.shown.includes(clean.LINK_TEXT)) return true;
  const v = screen.screenWorkOrderText({
    title: '', description: d.shown,
    spaced: { title: '', description: d.spaced }, symbols: { title: '', description: d.symbols }, both: { title: '', description: d.both },
  });
  return v.status === 'held';
}

// A circled, parenthesised or squared single letter: NFKC gives one letter (with or without brackets or a stop).
function isSpelledLetter(ch) {
  const n = ch.normalize('NFKC');
  if (n === ch || !/\p{L}/u.test(n)) return false;
  const rest = Array.from(n.replace(/[().\s]/g, ''));
  return rest.length === 1 && /^\p{L}$/u.test(rest[0]);
}

const codePoints = [];
let excluded = 0;
for (let c = 0; c <= 0x10FFFF; c++) {
  if (c >= 0xD800 && c <= 0xDFFF) continue;
  const ch = String.fromCodePoint(c);
  if (!/^[\p{P}\p{S}\p{Z}]$/u.test(ch)) continue;
  if (isSpelledLetter(ch)) { excluded++; continue; }
  codePoints.push(ch);
}

const started = Date.now();
let variants = 0;
const slips = [];
for (const ch of codePoints) {
  for (const ph of phrases) {
    if (limit && variants >= limit) break;
    variants++;
    if (!heldOrHidden(ctx(ph.replace(/ /g, ch)))) slips.push(`U+${ch.codePointAt(0).toString(16)}`);
  }
}
const result = {
  sharedPhrases: sharedCount, localPhrases: phrases.length - sharedCount, codePointsTested: codePoints.length, excludedLetters: excluded,
  variants, slips: slips.length, firstSlips: [...new Set(slips)].slice(0, 5), seconds: Math.round((Date.now() - started) / 1000),
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = slips.length ? 1 : 0;
