'use strict';

/**
 * lib/exif-date.js
 * Best-effort read of a photo's EXIF "when the shutter fired" timestamp,
 * for the Damage Photos feature (Mason requirement: capture when the
 * photo was actually taken, not just when it was uploaded — see
 * security-deposit/router.js's damage-photo route, and the
 * captured_at column added by
 * supabase/migrations/20260827010000_add_captured_at_to_documents.sql).
 *
 * Deliberately never throws and never returns anything it isn't
 * confident about: a missing/corrupt/stripped EXIF segment is the
 * common case (screenshots, re-saved images, photos that passed through
 * a messaging app that strips metadata, or a PNG — PNG has no EXIF
 * segment at all), not an error condition. Every failure path returns
 * null so the caller can store that and move on, per the spec ("does
 * not need to block upload if EXIF data is unavailable").
 */

const ExifParser = require('exif-parser');

// EXIF capture dates are plausible only within a bounded window. Rejects
// two real failure modes seen from actual devices/cameras rather than
// storing junk as if it were real evidence: (1) the classic 32-bit
// EXIF-epoch-underflow bug that produces a date around 1904, and (2) a
// camera with a dead/unset clock reporting a date decades in the future
// or the 1970 Unix epoch itself.
const EARLIEST_PLAUSIBLE_YEAR = 1995; // before consumer digital cameras existed

/**
 * @param {Buffer} buffer raw uploaded file bytes.
 * @returns {Date|null}
 */
function readExifCaptureDate(buffer) {
  try {
    const parser = ExifParser.create(buffer);
    const result = parser.parse();
    const tags = result && result.tags;
    if (!tags) return null;

    // DateTimeOriginal ("when the shutter fired") is what we actually
    // want. CreateDate is the same value on the overwhelming majority of
    // phone/camera photos, but is present on some devices where
    // DateTimeOriginal isn't — fall back to it rather than giving up.
    const epochSeconds = tags.DateTimeOriginal || tags.CreateDate;
    if (typeof epochSeconds !== 'number' || !isFinite(epochSeconds)) return null;

    const date = new Date(epochSeconds * 1000);
    if (isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    if (year < EARLIEST_PLAUSIBLE_YEAR || year > new Date().getFullYear() + 1) return null;

    return date;
  } catch (err) {
    // Malformed/absent EXIF (exif-parser throws on some non-JPEG or
    // truncated input rather than returning empty tags) — same "not
    // available" outcome as the checks above, not worth logging per
    // upload since it's expected for a meaningful fraction of files.
    return null;
  }
}

module.exports = { readExifCaptureDate };
