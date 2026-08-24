/**
 * lib/content-engine-paths.js
 * One tiny helper so every Hub file that needs to reach into
 * projects/content-engine's lib/ files does it through a single, named
 * path builder — never a hand-written relative path like
 * '../../content-engine/lib/draft' sprinkled across multiple files.
 *
 * Content-engine's code is NOT moved or copied into the Hub — it stays
 * exactly where it is (projects/content-engine/), same as content-review's
 * server.js already reused it directly (see that file's own header comment).
 * Both projects/hub/content-engine/router.js (the new drafting/scan panel)
 * and projects/hub/content-review/router.js (the migrated review app)
 * require content-engine's lib files through contentEnginePath() only —
 * that is the one thing that must not regress if anyone ever reorganizes
 * folders later: fix it here, once, instead of in every call site.
 *
 * Usage:
 *   const { contentEnginePath } = require('../lib/content-engine-paths');
 *   const { draftContent } = require(contentEnginePath('lib/draft'));
 */

const path = require('path');

const CONTENT_ENGINE_DIR = path.join(__dirname, '..', '..', 'content-engine');

function contentEnginePath(...segments) {
  return path.join(CONTENT_ENGINE_DIR, ...segments);
}

module.exports = { CONTENT_ENGINE_DIR, contentEnginePath };
