'use strict';

/**
 * lib/image-resize.js
 * Shrinks a photo's bytes down to something reasonable for Claude to
 * compare visually — added to fix the root cause TARS's real-folder
 * accuracy study found (2026-08-24 report, 23 real submissions across 8
 * properties): sending full-resolution 2-5MB phone-camera originals let
 * the running byte budget in router.js's photo-matches route run out
 * after only a handful of candidates (3-8 out of a typical ~100-photo
 * folder), so the AI was answering "does this narrow slice contain a
 * match" instead of "does this folder contain a match." A photo doesn't
 * need to be full-resolution to answer "is this the same room" — shrinking
 * it first means dramatically more candidates fit inside any reasonable
 * request budget.
 *
 * Used for BOTH the move-out photo and every move-in candidate (router.js)
 * before they're handed to lib/photo-matcher.js's matchPhoto() — same
 * treatment on both sides, so the AI is comparing two images resized the
 * same way rather than a shrunk candidate against a full-res move-out
 * original.
 */

const sharp = require('sharp');

// The fix spec suggested roughly 1000-1500px on the long edge; 1280 sits
// in the middle. Chosen specifically to sit under two different Claude
// API ceilings at once (docs pulled live 2026-08-24, re-confirmed
// 2026-08-25 against every-photo-checked batches — see
// MAX_CANDIDATES_PER_BATCH in router.js): (1) any request with more than
// 20 image blocks — which this route now routinely sends, one batch of a
// move-in folder's photos at a time — is only accepted if every image is
// under roughly 2000px on a side, and (2) Claude's own standard-resolution
// tier caps useful detail at a 1568px long edge regardless, so sending
// anything larger than that just spends bytes on pixels Claude would
// downscale away anyway. 1280 leaves margin under both without visibly
// under-detailing a room/area comparison.
const MAX_DIMENSION = 1280;
// JPEG at this quality keeps real inspection-photo detail (wall texture,
// fixtures, visible damage) legible while landing well under a megabyte
// even for a busy, high-detail room shot — the actual number that makes
// dozens of candidates fit in one request instead of 3-8.
const JPEG_QUALITY = 82;

/**
 * @param {Buffer} buffer
 * @param {string|null} [contentType] original content type — only used as
 *   the fallback return value on failure; the resized output is always
 *   image/jpeg.
 * @returns {Promise<{buffer: Buffer, contentType: string|null}>}
 *   On any resize failure (corrupt bytes, an exotic format sharp can't
 *   decode, etc.) this falls back to the ORIGINAL buffer and contentType
 *   unchanged rather than throwing — one bad photo degrades to "sent at
 *   full size" (still caught by the caller's own MAX_SINGLE_IMAGE_BYTES
 *   backstop), not a failed match request. Deliberately no retry here —
 *   a resize failure is almost always a bad/corrupt input, not a
 *   transient condition retrying would fix (unlike the Claude API retry
 *   in lib/photo-matcher.js, which is for a genuinely transient failure).
 */
async function resizeForMatching(buffer, contentType) {
  try {
    const resized = await sharp(buffer)
      .rotate() // apply EXIF orientation first — phone photos are frequently stored sideways/upside-down relative to how they display
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    return { buffer: resized, contentType: 'image/jpeg' };
  } catch (err) {
    console.error('[security-deposit photo-match] image resize failed, falling back to original bytes:', err.message);
    return { buffer, contentType: contentType || null };
  }
}

module.exports = { resizeForMatching, MAX_DIMENSION, JPEG_QUALITY };
